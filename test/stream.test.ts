import assert from "node:assert/strict";
import { test } from "node:test";
import { APIConnectionError, SynthientError, toDate, type TLSClientHello } from "../src/index.ts";
import {
  BASE_URL,
  chunked,
  collect,
  newClient,
  problem,
  rateLimited,
  serve,
  stub,
  trickle,
} from "./helpers.ts";

const EVENTS = [
  { ip: "1.2.3.4", provider: "BRIGHTDATA", type: "RESIDENTIAL_PROXY", timestamp: 1778187600 },
  { ip: "5.6.7.8", provider: "ÜBERPROXY 代理", asn: 4294967295 },
  { ip: "9.9.9.9" },
];
const NDJSON = EVENTS.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("stream parses NDJSON events", async () => {
  const { fetch, requests } = stub(() => chunked([NDJSON]));

  const events = await collect(newClient({ fetch }).proxies.stream());

  assert.deepEqual(events, EVENTS);
  assert.equal(requests[0]?.url, `${BASE_URL}/feeds/proxies/stream`);
  assert.equal(requests[0].headers.get("accept"), "application/x-ndjson");
});

test("stream handles a payload split at every byte offset", async () => {
  const bytes = new TextEncoder().encode(NDJSON);
  for (let split = 0; split <= bytes.length; split++) {
    const { fetch } = stub(() => chunked([bytes.subarray(0, split), bytes.subarray(split)]));

    assert.deepEqual(
      await collect(newClient({ fetch }).proxies.stream()),
      EVENTS,
      `split ${split}`,
    );
  }

  const { fetch } = stub(() => chunked([...bytes].map((byte) => Uint8Array.of(byte))));
  assert.deepEqual(await collect(newClient({ fetch }).proxies.stream()), EVENTS);
});

test("stream skips keepalives, strips CRLF, and accepts a final line without a newline", async () => {
  const { fetch } = stub(() => {
    return chunked(["\n", '{"ip":"1.1.1.1"}\r\n', "  \n\n", '{"ip":"2.2.2.2"}']);
  });

  const events = await collect(newClient({ fetch }).proxies.stream());

  assert.deepEqual(events, [{ ip: "1.1.1.1" }, { ip: "2.2.2.2" }]);
});

test("stream passes Helios HTTPS ClientHellos through", async () => {
  const meta = { proxy_ip: "198.51.100.7", server: "helios-1", pool_id: "p1", provider: "X" };
  const base = { timestamp: 1778187600123, tunnel_id: 42, domain: "example.com", port: 443 };
  const hello = {
    handshake_version: "TLS 1.2",
    sni: "example.com",
    cipher_suites: [{ code: 4865, name: "TLS_AES_128_GCM_SHA256" }],
    extensions: [{ code: 0, name: "server_name", length: 16 }],
    has_grease: true,
  };
  const lines = [
    { ...base, protocol: "https", meta, details: hello, raw: null },
    { ...base, protocol: "https", meta, details: null, raw: null },
  ];
  const { fetch } = stub(() => chunked([lines.map((line) => JSON.stringify(line)).join("\n")]));

  const events = await collect(newClient({ fetch }).heliosHTTPS.stream());

  assert.deepEqual(
    events,
    lines.map((line) => ({ ...line, tunnel_id: "42" })),
  );
});

test("stream decodes every new TLSClientHello field, or none", async () => {
  const meta = { proxy_ip: "203.0.113.10", server: "hp-eu-1", pool_id: "prod", provider: "X" };
  const base = { timestamp: 1714780800123, tunnel_id: 42, domain: "example.com", port: 443 };
  const hello = {
    record_version: "TLS 1.0",
    record_version_code: 769,
    handshake_version: "TLS 1.2",
    handshake_version_code: 771,
    supported_version_codes: [2570, 772, 771],
    alpn_hex: ["6832", "687474702f312e31"],
    signature_algorithms_cert: [{ code: 2052, name: "rsa_pss_rsae_sha256" }],
    record_size_limit: 16385,
    max_fragment_length: 4,
    complete: false,
    truncated: true,
    transport: "tcp",
  } satisfies TLSClientHello;
  const lines = [hello, {}].map((details) => {
    return { ...base, protocol: "https", meta, transport: "tcp", details };
  });
  const { fetch, requests } = stub(() => {
    return chunked([lines.map((line) => JSON.stringify(line)).join("\n")]);
  });

  const events = await collect(newClient({ fetch }).heliosHTTPS.stream());

  assert.deepEqual(
    events,
    lines.map((line) => ({ ...line, tunnel_id: "42" })),
  );
  assert.equal(requests[0]?.url, `${BASE_URL}/feeds/helios/https/stream`);
});

test("stream decodes the Helios DNS and HTTPS transport, including new values", async () => {
  const meta = { proxy_ip: "203.0.113.10", server: "hp-eu-1", pool_id: "prod", provider: "X" };
  for (const protocol of ["dns", "https"] as const) {
    const lines = ["tcp", "udp", "quic", "sctp"].map((transport) => {
      return {
        timestamp: 1714780800123,
        tunnel_id: 7,
        domain: "a.test",
        port: 53,
        protocol,
        meta,
        transport,
      };
    });
    const { fetch } = stub(() => chunked([lines.map((line) => JSON.stringify(line)).join("\n")]));
    const client = newClient({ fetch });

    const events = await collect<{ transport: string }>(
      protocol === "dns" ? client.heliosDNS.stream() : client.heliosHTTPS.stream(),
    );

    assert.deepEqual(
      events.map((event) => event.transport),
      ["tcp", "udp", "quic", "sctp"],
    );
  }
});

test("stream decodes Helios ADB events with and without meta", async () => {
  const meta = { proxy_ip: "203.0.113.10", server: "hp-eu-1", pool_id: "prod", provider: "X" };
  const base = {
    session: "00075b3dde7ddb645347a137f01ac991",
    sequential_id: 3,
    command: "cd /data/local/tmp",
    hash: "cd6d",
  };
  const lines = [
    { ...base, meta },
    { ...base, meta: null },
  ];
  const { fetch, requests } = stub(() =>
    chunked([lines.map((line) => JSON.stringify(line)).join("\n")]),
  );

  const events = await collect(newClient({ fetch }).heliosADB.stream());

  assert.deepEqual(events, lines);
  assert.equal(requests[0]?.url, `${BASE_URL}/feeds/helios/adb/stream`);
});

test("stream keeps Helios tunnel IDs as their exact digits", async () => {
  const ids = ["0", "1942782", "9007199254740993", "17257744507466107949", "18446744073709551615"];
  const body = ids.map((id) => `{"timestamp":1778187600123,"tunnel_id":${id}}`).join("\n");
  const client = newClient({ fetch: stub(() => chunked([body])).fetch });

  for (const feed of [client.heliosHTTP, client.heliosHTTPS, client.heliosDNS]) {
    const events = await collect<{ tunnel_id: string }>(feed.stream());
    assert.deepEqual(
      events.map((event) => event.tunnel_id),
      ids,
    );
  }
});

test("stream rejects invalid and oversized events", async () => {
  for (const body of ['{"ip":"1.1.1.1"}\n{bad json}\n', "[1]\n", "5\n"]) {
    const { fetch } = stub(() => chunked([body]));
    await assert.rejects(collect(newClient({ fetch }).proxies.stream()), SynthientError);
  }

  const huge = new Uint8Array((16 << 20) + 1).fill(97);
  for (const chunks of [[huge], [huge.subarray(0, 1 << 20), huge.subarray(1 << 20), "\n"]]) {
    const { fetch } = stub(() => chunked(chunks));
    await assert.rejects(collect(newClient({ fetch }).proxies.stream()), {
      name: "SynthientError",
      message: `stream event exceeds ${16 << 20} bytes`,
    });
  }
});

test("stream limits multibyte events by their byte size", async () => {
  const body = JSON.stringify({ provider: "é".repeat(9 << 20) });
  for (const chunks of [[body + "\n"], [body.slice(0, 1 << 20), body.slice(1 << 20)]]) {
    const { fetch } = stub(() => chunked(chunks));
    await assert.rejects(collect(newClient({ fetch }).proxies.stream()), {
      name: "SynthientError",
      message: `stream event exceeds ${16 << 20} bytes`,
    });
  }
});

test("stream reports a failed handshake on the first next()", async () => {
  const { fetch, requests } = stub(() =>
    problem(403, { detail: "Requires one of: PROXY_FIREHOSE" }),
  );

  const events = newClient({ fetch }).proxies.stream();
  assert.equal(requests.length, 0);

  await assert.rejects(events.next(), { name: "APIError", status: 403 });
  assert.equal(requests.length, 1);
});

test("stream retries its handshake and requires 200", async () => {
  const { fetch, requests } = stub((_, index) => {
    return index === 0 ? rateLimited() : chunked([NDJSON]);
  });
  assert.deepEqual(await collect(newClient({ fetch }).proxies.stream()), EVENTS);
  assert.equal(requests.length, 2);

  const empty = stub(() => new Response(null, { status: 204 }));
  await assert.rejects(collect(newClient({ fetch: empty.fetch }).proxies.stream()), {
    status: 204,
  });
});

test("breaking out of a stream closes the connection", async (t) => {
  const { server, closed } = await trickle(t, '{"ip":"1.1.1.1"}\n');

  let count = 0;
  for await (const event of newClient({ baseURL: server.baseURL }).proxies.stream()) {
    assert.deepEqual(event, { ip: "1.1.1.1" });
    if (++count === 2) {
      break;
    }
  }

  await closed;
});

test("a connection lost mid-stream is an error, not the end", async (t) => {
  const server = await serve(t, (_, res) => {
    res.write('{"ip":"1.1.1.1"}\n');
    setTimeout(() => res.destroy(), 20);
  });

  const seen: unknown[] = [];
  await assert.rejects(async () => {
    for await (const event of newClient({ baseURL: server.baseURL }).proxies.stream()) {
      seen.push(event);
    }
  }, APIConnectionError);
  assert.deepEqual(seen, [{ ip: "1.1.1.1" }]);
});

test("toDate reads seconds and millisecond timestamps", () => {
  assert.equal(toDate(1778187600).toISOString(), "2026-05-07T21:00:00.000Z");
  assert.equal(toDate(1778187600123).toISOString(), "2026-05-07T21:00:00.123Z");
  assert.equal(toDate(0).getTime(), 0);
});
