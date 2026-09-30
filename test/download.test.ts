import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type ResponseMetadata,
} from "../src/index.ts";
import {
  API_KEY,
  BASE_URL,
  closedPort,
  newClient,
  problem,
  redirect,
  redirectTo,
  serve,
  stub,
  trickle,
  type Recorded,
} from "./helpers.ts";

const PRESIGNED =
  "https://storage.test/proxies/2026-05-07.parquet?X-Amz-Signature=secret-signature";

/** Answers API requests with a redirect to PRESIGNED and storage requests with `storage`. */
function storageStub(storage: (request: Recorded, index: number) => Response) {
  let storageIndex = 0;
  return stub((request) => {
    return request.url.startsWith(BASE_URL)
      ? redirect(PRESIGNED)
      : storage(request, storageIndex++);
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

test("downloadURL returns the presigned location", async () => {
  const seen: ResponseMetadata[] = [];
  const { fetch, requests } = storageStub(() => new Response("unused"));
  const client = newClient({ fetch, onResponse: (metadata) => seen.push(metadata) });

  const url = await client.proxies.downloadURL("2026-05-07");
  const hourly = await client.proxies.downloadURL("2026-05-07/09");

  assert.equal(url.href, PRESIGNED);
  assert.equal(hourly.href, PRESIGNED);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      `${BASE_URL}/feeds/proxies/export/2026-05-07`,
      `${BASE_URL}/feeds/proxies/export/2026-05-07/9`,
    ],
  );
  assert.deepEqual(
    seen.map((metadata) => metadata.status),
    [307, 307],
  );
});

test("downloadURL resolves a relative location and allows http for an http base", async (t) => {
  const server = await redirectTo(t, "/storage/2026-05-07.parquet?sig=x");

  const url = await newClient({ baseURL: server.baseURL }).proxies.downloadURL("latest");

  assert.equal(url.href, `${server.origin}/storage/2026-05-07.parquet?sig=x`);
});

test("downloadURL resolves a relative location against the request, not response.url", async () => {
  const fetch = () => Promise.resolve(redirect("../storage/x.parquet?sig=x"));

  const url = await newClient({ fetch }).proxies.downloadURL("2026-05-07/9");

  assert.equal(url.href, `${BASE_URL}/feeds/proxies/export/storage/x.parquet?sig=x`);
});

test("downloadURL preserves cancellation while draining a redirect", async (t) => {
  const server = await serve(t, (_, res) => {
    res.writeHead(307, { location: PRESIGNED });
    res.write("redirecting");
  });
  const signal = AbortSignal.timeout(100);

  await assert.rejects(
    newClient({ baseURL: server.baseURL }).proxies.downloadURL("latest", { signal }),
    (error) => error === signal.reason,
  );
});

test("downloadURL rejects invalid redirects", async () => {
  const cases = [
    [new Response(null, { status: 307 }), "export redirect has no valid location"],
    [redirect("http://storage.test/x"), "export redirect does not use https"],
    [redirect("ftp://storage.test/x"), "export redirect does not use https"],
    [redirect("https://user:pass@storage.test/x"), "export redirect has no valid location"],
    [new Response("{}", { status: 200 }), "expected a redirect to the export, got status 200"],
  ] as const;
  for (const [response, message] of cases) {
    const { fetch } = stub(() => response);
    await assert.rejects(newClient({ fetch }).proxies.downloadURL("latest"), {
      name: "SynthientError",
      message,
    });
  }

  const { fetch } = stub(() => {
    return new Response('{"title":"Not Found"}', { status: 404, headers: { "retry-after": "60" } });
  });
  await assert.rejects(newClient({ fetch }).proxies.downloadURL("2026-05-07"), {
    name: "APIError",
    status: 404,
    retryAfter: 60_000,
  });
});

test("download fetches storage without the API key", async (t) => {
  const storage = await serve(t, (_, res) => {
    res.end("PAR1 parquet bytes");
  });
  const api = await redirectTo(t, `${storage.origin}/proxies/latest.parquet?sig=secret`);

  const body = await newClient({ baseURL: api.baseURL }).proxies.download("latest");

  assert.equal(await text(body), "PAR1 parquet bytes");
  assert.equal(api.requests[0]?.headers["x-api-key"], API_KEY);
  assert.equal(storage.requests[0]?.headers["x-api-key"], undefined);
  assert.match(storage.requests[0]?.headers["user-agent"] ?? "", /^synthient-node\//);
  assert.equal(storage.requests[0]?.url, "/proxies/latest.parquet?sig=secret");
});

test("download follows safe storage redirects only", async () => {
  const hops = (count: number) => {
    return storageStub((_, index) => {
      return index < count
        ? redirect(`https://storage.test/hop/${index}`, 302)
        : new Response("ok");
    });
  };
  assert.equal(
    await text(await newClient({ fetch: hops(10).fetch }).proxies.download("latest")),
    "ok",
  );
  await assert.rejects(newClient({ fetch: hops(11).fetch }).proxies.download("latest"), {
    message: "too many export redirects",
  });

  const cases = [
    ["http://storage.test/b", "export redirect does not use https"],
    ["ftp://storage.test/b", "export redirect has an unsupported location"],
    ["https://user:pass@storage.test/b", "export redirect has an unsupported location"],
  ] as const;
  for (const [location, message] of cases) {
    const { fetch, requests } = storageStub(() => redirect(location, 302));
    await assert.rejects(newClient({ fetch }).proxies.download("latest"), {
      name: "SynthientError",
      message,
    });
    assert.equal(requests.length, 2);
  }
});

test("storage errors keep the status but not the body or URL", async () => {
  const { fetch } = storageStub(() => {
    return new Response(
      `<Error><Code>SignatureDoesNotMatch</Code><StringToSign>${PRESIGNED}</StringToSign></Error>`,
      { status: 403 },
    );
  });

  await assert.rejects(newClient({ fetch }).proxies.download("latest"), (error: unknown) => {
    assert.ok(error instanceof APIError);
    assert.equal(error.status, 403);
    assert.doesNotMatch(inspect(error, { depth: Infinity }), /secret-signature/);
    return true;
  });
});

test("an unreachable storage host does not leak the URL", async (t) => {
  const port = await closedPort();
  const api = await redirectTo(t, `http://127.0.0.1:${port}/x?X-Amz-Signature=secret-signature`);

  await assert.rejects(
    newClient({ baseURL: api.baseURL }).proxies.download("latest"),
    (error: unknown) => {
      assert.ok(error instanceof APIConnectionError);
      assert.doesNotMatch(inspect(error, { depth: Infinity }), /secret-signature/);
      return true;
    },
  );
});

test("canceling a download closes the storage connection", async (t) => {
  const { server: storage, closed } = await trickle(t, "chunk");
  const api = await redirectTo(t, `${storage.origin}/file.parquet`);

  const body = await newClient({ baseURL: api.baseURL }).proxies.download("latest");
  const reader = body.getReader();
  assert.ok((await reader.read()).value);
  await reader.cancel();

  await closed;
});

test("a stalled download times out", async (t) => {
  const storage = await serve(t, (_, res) => {
    res.write("partial");
  });
  const api = await redirectTo(t, `${storage.origin}/file.parquet`);

  const body = await newClient({ baseURL: api.baseURL, timeout: 100 }).proxies.download("latest");
  const reader = body.getReader();
  assert.ok((await reader.read()).value);

  await assert.rejects(reader.read(), APITimeoutError);
});

test("download reports API errors before contacting storage", async () => {
  const { fetch, requests } = stub(() => problem(403, { detail: "Requires one of: PROXY_FEEDS" }));

  await assert.rejects(newClient({ fetch }).proxies.download("latest"), { status: 403 });
  assert.equal(requests.length, 1);
  await assert.rejects(newClient({ fetch }).proxies.download("nope"), TypeError);
});
