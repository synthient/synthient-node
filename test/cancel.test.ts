import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { APIConnectionError, APITimeoutError } from "../src/index.ts";
import { wait } from "../src/transport.ts";
import { EXPORT, newClient, problem, serve, stub } from "./helpers.ts";

test("an already aborted signal sends nothing", async (t) => {
  const server = await serve(t, (_, res) => res.end("{}"));
  const reason = new Error("stop");

  await assert.rejects(
    newClient({ baseURL: server.baseURL }).account({ signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  assert.equal(server.requests.length, 0);
});

test("aborting rejects with the signal's reason", async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === "/api/v4/account/me") {
      return;
    }
    res.setHeader("content-type", "application/json");
    res.write('{"ip":');
  });
  const client = newClient({ baseURL: server.baseURL });

  for (const [call, reason] of [
    [(signal: AbortSignal) => client.account({ signal }), new Error("during headers")],
    [(signal: AbortSignal) => client.lookupIP("8.8.8.8", { signal }), "during body"],
  ] as const) {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(reason);
    }, 50);

    await assert.rejects(call(controller.signal), (error) => error === reason);
  }
});

test("AbortSignal.timeout rejects with its TimeoutError", async (t) => {
  const server = await serve(t, () => undefined);

  await assert.rejects(
    newClient({ baseURL: server.baseURL }).account({ signal: AbortSignal.timeout(50) }),
    { name: "TimeoutError" },
  );
});

test("aborting during backoff stops retrying", async () => {
  const { fetch, requests } = stub(() => problem(503));
  const controller = new AbortController();
  const reason = new Error("stop");
  const client = newClient({ fetch }, (_, signal) => {
    controller.abort(reason);
    return wait(60_000, signal);
  });

  await assert.rejects(client.account({ signal: controller.signal }), (error) => error === reason);
  assert.equal(requests.length, 1);
});

test("aborting stops pagination and streams", async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === "/api/v4/feeds/proxies/export") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ stream: "proxies", feeds: [EXPORT], next_cursor: "next" }));
    } else if (req.url === "/api/v4/feeds/proxies/stream") {
      res.write('{"ip":"1.2.3.4"}\n');
    }
  });
  const client = newClient({ baseURL: server.baseURL });

  const pages = new AbortController();
  const exports = client.proxies.allExports(undefined, { signal: pages.signal });
  assert.deepEqual((await exports.next()).value, EXPORT);
  const second = exports.next();
  pages.abort("pages");
  await assert.rejects(second, (error) => error === "pages");

  const streaming = new AbortController();
  const events = client.proxies.stream({ signal: streaming.signal });
  assert.deepEqual((await events.next()).value, { ip: "1.2.3.4" });
  const next = events.next();
  streaming.abort("stream");
  await assert.rejects(next, (error) => error === "stream");
});

test("the idle timeout bounds waiting for headers and body data", async (t) => {
  const server = await serve(t, (req, res) => {
    if (req.url === "/api/v4/lookup/ip/8.8.4.4") {
      res.setHeader("content-type", "application/json");
      res.write('{"ip":');
    }
  });
  const client = newClient({ baseURL: server.baseURL, timeout: 100 });

  await assert.rejects(client.lookupIP("8.8.8.8"), (error: unknown) => {
    return error instanceof APITimeoutError && error instanceof APIConnectionError;
  });
  await assert.rejects(client.lookupIP("8.8.4.4"), APITimeoutError);
  assert.equal(server.requests.length, 2);

  await assert.rejects(client.account(), APITimeoutError);
  assert.equal(server.requests.length, 5);
});

test("a slow consumer does not trip the idle timeout", async (t) => {
  const server = await serve(t, (_, res) => {
    res.write('{"ip":"1.1.1.1"}\n{"ip":"2.2.2.2"}\n');
    setTimeout(() => res.end(), 20);
  });
  const client = newClient({ baseURL: server.baseURL, timeout: 100 });

  const seen: unknown[] = [];
  for await (const event of client.proxies.stream()) {
    seen.push(event);
    await sleep(250);
  }

  assert.deepEqual(seen, [{ ip: "1.1.1.1" }, { ip: "2.2.2.2" }]);
});
