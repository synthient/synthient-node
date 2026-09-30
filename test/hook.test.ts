import assert from "node:assert/strict";
import { test } from "node:test";
import { SynthientError, type ResponseMetadata } from "../src/index.ts";
import { EXPORT, IP_INFO, chunked, collect, json, newClient, problem, stub } from "./helpers.ts";

test("the hook sees retries, pages, stream handshakes, and decode failures", async () => {
  const seen: ResponseMetadata[] = [];
  const responses = [
    () => problem(503),
    () => json(200, IP_INFO, { "x-request-id": "first", "ratelimit-remaining": "9" }),
    () => json(200, { stream: "proxies", feeds: [EXPORT], next_cursor: "c1" }),
    () => json(200, { stream: "proxies", feeds: [] }),
    () => chunked(['{"ip":"1.1.1.1"}\n']),
    () => new Response("{bad", { status: 200 }),
  ];
  const { fetch } = stub((_, index) => responses[index]?.() ?? problem(500));
  const client = newClient({ fetch, onResponse: (metadata) => seen.push(metadata) });

  await client.account();
  await collect(client.proxies.allExports());
  await collect(client.proxies.stream());
  await assert.rejects(client.account(), SynthientError);

  assert.deepEqual(
    seen.map((metadata) => metadata.status),
    [503, 200, 200, 200, 200, 200],
  );
  assert.equal(seen[1]?.requestID, "first");
  assert.equal(seen[0]?.requestID, "");
  assert.equal(seen[1].headers.get("ratelimit-remaining"), "9");
});

test("the hook gets a mutable copy of the headers", async () => {
  const seen: ResponseMetadata[] = [];
  const { fetch } = stub(() => json(200, IP_INFO));

  await newClient({ fetch, onResponse: (metadata) => seen.push(metadata) }).lookupIP("8.8.8.8");
  seen[0]?.headers.set("x-extra", "1");

  assert.equal(seen[0]?.headers.get("x-extra"), "1");
});

test("a throwing hook becomes a warning and keeps the result", async (t) => {
  const emitWarning = t.mock.method(process, "emitWarning", () => undefined);
  const { fetch, requests } = stub(() => json(200, IP_INFO));
  const client = newClient({
    fetch,
    onResponse: () => {
      throw new Error("hook failed");
    },
  });

  const info = await client.lookupIP("8.8.8.8");

  assert.deepEqual(info, IP_INFO);
  assert.equal(emitWarning.mock.callCount(), 1);
  assert.equal((emitWarning.mock.calls[0]?.arguments[0] as Error).message, "hook failed");
  assert.equal(requests.length, 1);
});
