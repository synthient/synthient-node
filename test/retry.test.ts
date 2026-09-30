import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { APIConnectionError, APIError, APITimeoutError } from "../src/index.ts";
import { parseRetryAfter } from "../src/errors.ts";
import { backoff } from "../src/transport.ts";
import {
  IP_INFO,
  closedPort,
  json,
  listen,
  newClient,
  problem,
  rateLimited,
  recordWaits,
  serve,
  stub,
} from "./helpers.ts";

function failure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

test("free requests retry rate limits and server errors", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const { fetch, requests } = stub(() => problem(status, {}, { "retry-after": "0" }));
    const [waits, wait] = recordWaits();
    const client = newClient({ fetch }, wait);

    await assert.rejects(client.account(), { name: "APIError", status });
    assert.equal(requests.length, 3, `status ${status}`);
    assert.equal(waits.length, 2);
  }
});

test("billed requests retry only rate limits", async () => {
  for (const [status, attempts] of [
    [429, 3],
    [500, 1],
    [502, 1],
    [503, 1],
    [504, 1],
  ] as const) {
    const { fetch, requests } = stub(() => problem(status, {}, { "retry-after": "0" }));
    const client = newClient({ fetch });

    await assert.rejects(client.lookupIP("8.8.8.8"), { status });
    await assert.rejects(client.lookupIPs(["8.8.8.8"]), { status });
    await assert.rejects(client.lookupDomain("example.com"), { status });
    assert.equal(requests.length, attempts * 3, `status ${status}`);
  }
});

test("permanent statuses are not retried", async () => {
  for (const status of [400, 401, 402, 403, 404, 422]) {
    const { fetch, requests } = stub(() => problem(status));

    await assert.rejects(newClient({ fetch }).account(), { status });
    assert.equal(requests.length, 1);
  }
});

test("a retried request can succeed", async () => {
  const { fetch, requests } = stub((_, index) => {
    return index === 0 ? problem(503) : json(200, { email: "a@example.com" });
  });

  const account = await newClient({ fetch }).account();

  assert.equal(account.email, "a@example.com");
  assert.equal(requests.length, 2);
});

test("retries back off exponentially and honor Retry-After", async () => {
  const { fetch } = stub((_, index) => {
    return rateLimited(index === 1 ? "5" : "0");
  });
  const [waits, wait] = recordWaits();
  const client = newClient({ fetch, maxRetries: 3 }, wait);

  await assert.rejects(client.lookupIP("8.8.8.8"), { status: 429 });

  const [first, second, third] = waits;
  assert.ok(first !== undefined && first >= 750 && first <= 1250, `first wait ${first}`);
  assert.equal(second, 5000);
  assert.ok(third !== undefined && third >= 3000 && third <= 5000, `third wait ${third}`);
});

test("a Retry-After longer than a minute is returned instead of waited", async () => {
  const { fetch, requests } = stub(() => rateLimited("120"));

  await assert.rejects(newClient({ fetch }).account(), { status: 429, retryAfter: 120_000 });
  assert.equal(requests.length, 1);
});

test("a 429 without Retry-After is a spent budget and is not retried", async () => {
  const { fetch, requests } = stub(() => problem(429, { detail: "monthly request budget spent" }));
  const client = newClient({ fetch });

  await assert.rejects(client.lookupIP("8.8.8.8"), { status: 429, retryAfter: undefined });
  await assert.rejects(client.account(), { status: 429 });
  await assert.rejects(client.proxies.stream().next(), { status: 429 });
  assert.equal(requests.length, 3);
});

test("maxRetries 0 sends one attempt", async () => {
  const { fetch, requests } = stub(() => problem(429));

  await assert.rejects(newClient({ fetch, maxRetries: 0 }).account(), APIError);
  await assert.rejects(newClient({ fetch, maxRetries: 0 }).lookupIP("8.8.8.8"), APIError);
  assert.equal(requests.length, 2);
});

test("connection failures are retried only for free requests", async () => {
  const { fetch, requests } = stub(() => Promise.reject(failure("ECONNRESET")));
  const client = newClient({ fetch });

  await assert.rejects(client.account(), (error: unknown) => {
    return error instanceof APIConnectionError && error.cause instanceof TypeError;
  });
  assert.equal(requests.length, 3);

  requests.length = 0;
  await assert.rejects(client.lookupIP("8.8.8.8"), APIConnectionError);
  assert.equal(requests.length, 1);
});

test("free JSON requests retry interrupted response bodies", async (t) => {
  const server = await serve(t, (_, res) => {
    if (server.requests.length === 1) {
      res.write('{"email":');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end('{"email":"a@example.com"}');
  });

  const account = await newClient({ baseURL: server.baseURL }).account();

  assert.equal(account.email, "a@example.com");
  assert.equal(server.requests.length, 2);
});

test("JSON body failures share the retry budget with headers and statuses", async () => {
  const { fetch, requests } = stub((_, index) => {
    if (index === 0) {
      throw failure("ECONNRESET");
    }
    if (index === 1) {
      return problem(503);
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure("ECONNRESET"));
        },
      }),
    );
  });
  const [waits, wait] = recordWaits();

  await assert.rejects(newClient({ fetch }, wait).account(), APIConnectionError);
  assert.equal(requests.length, 3);
  assert.equal(waits.length, 2);
});

test("billed lookups do not retry interrupted response bodies", async (t) => {
  const server = await serve(t, (_, res) => {
    res.write('{"ip":');
    setTimeout(() => res.destroy(), 20);
  });
  const client = newClient({ baseURL: server.baseURL });

  for (const lookup of [
    () => client.lookupIP("8.8.8.8"),
    () => client.lookupIPs(["8.8.8.8"]),
    () => client.lookupDomain("example.com"),
  ]) {
    await assert.rejects(lookup(), APIConnectionError);
  }
  assert.equal(server.requests.length, 3);
});

test("free JSON requests retry stalled bodies within their retry budget", async (t) => {
  const server = await serve(t, (_, res) => {
    res.write('{"email":');
  });

  await assert.rejects(
    newClient({ baseURL: server.baseURL, timeout: 50 }).account(),
    APITimeoutError,
  );
  assert.equal(server.requests.length, 3);
});

test("permanent connection failures are not retried", async () => {
  for (const error of [failure("DEPTH_ZERO_SELF_SIGNED_CERT"), new Error("custom fetch failure")]) {
    const { fetch, requests } = stub(() => Promise.reject(error));

    await assert.rejects(newClient({ fetch }).account(), APIConnectionError);
    assert.equal(requests.length, 1);
  }
});

test("a custom fetch that throws synchronously rejects with APIConnectionError", async () => {
  const fetch = () => {
    throw new TypeError("sync failure");
  };

  await assert.rejects(newClient({ fetch }).account(), (error: unknown) => {
    return error instanceof APIConnectionError && error.cause instanceof TypeError;
  });
});

test("a TLS failure against a real socket is not retried", async (t) => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.end("HTTP/1.1 200 OK\r\n\r\n");
  });
  const port = await listen(server);
  t.after(() => server.close());

  const client = newClient({ baseURL: `https://127.0.0.1:${port}/api/v4` });

  await assert.rejects(client.account(), APIConnectionError);
  assert.equal(connections, 1);
});

test("a refused connection is retried for free requests", async () => {
  const port = await closedPort();
  const [waits, wait] = recordWaits();
  const client = newClient({ baseURL: `http://127.0.0.1:${port}/api/v4` }, wait);

  await assert.rejects(client.account(), APIConnectionError);
  assert.equal(waits.length, 2);
});

test("billed requests are not replayed on a reused connection", async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === "/api/v4/account/me") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    req.socket.destroy();
  });
  const client = newClient({ baseURL: server.baseURL });

  for (const lookup of [() => client.lookupIP("8.8.8.8"), () => client.lookupIPs(["8.8.8.8"])]) {
    server.requests.length = 0;
    await client.account();
    await sleep(0);
    await assert.rejects(lookup(), APIConnectionError);

    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]?.remotePort, server.requests[1]?.remotePort);
  }
});

test("free requests are retried after a reset on a reused connection", async (t) => {
  const server = await serve(t, (_, res) => {
    if (server.requests.length === 2) {
      res.socket?.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(IP_INFO));
  });
  const client = newClient({ baseURL: server.baseURL });

  await client.account();
  await sleep(0);
  await client.account();

  assert.equal(server.requests.length, 3);
});

test("parseRetryAfter accepts seconds and IMF-fixdates only", () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const past = new Date(Date.now() - 10_000).toUTCString();
  const cases: [string | null, number | undefined][] = [
    [null, undefined],
    ["", undefined],
    ["0", 0],
    ["5", 5000],
    [" 5 ", 5000],
    ["-3", 0],
    ["99999999999999", 2 ** 31 * 1000],
    ["1.5", undefined],
    ["0x10", undefined],
    ["1e3", undefined],
    ["soon", undefined],
    [past, 0],
    ["Sunday, 06-Nov-94 08:49:37 GMT", undefined],
    ["Sun Nov  6 08:49:37 1994", undefined],
  ];
  for (const [header, expected] of cases) {
    assert.equal(parseRetryAfter(header), expected, String(header));
  }
  const delay = parseRetryAfter(future);
  assert.ok(delay !== undefined && delay > 8000 && delay <= 10_000, `future delay ${delay}`);
});

test("backoff stays within its jitter bounds", () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const base = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
    for (let i = 0; i < 50; i++) {
      const delay = backoff(attempt);
      assert.ok(delay >= base * 0.75 && delay <= base * 1.25, `attempt ${attempt}: ${delay}`);
    }
  }
});
