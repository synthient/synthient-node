import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";
import * as sdk from "../src/index.ts";
import {
  Synthient,
  VERSION,
  type IPInfo,
  type Organization,
  type ServiceCategory,
} from "../src/index.ts";
import { API_KEY, BASE_URL, IP_INFO, json, newClient, setAPIKeyEnv, stub } from "./helpers.ts";

const account = { email: "a@example.com", scopes: ["BASIC"] };

test("reads the API key from SYNTHIENT_API_KEY", async (t) => {
  setAPIKeyEnv(t, " env-key ");
  const { fetch, requests } = stub(() => json(200, account));

  await new Synthient({ baseURL: BASE_URL, fetch }).account();
  await new Synthient({ apiKey: "explicit", baseURL: BASE_URL, fetch }).account();

  assert.equal(requests[0]?.headers.get("x-api-key"), "env-key");
  assert.equal(requests[1]?.headers.get("x-api-key"), "explicit");
  assert.throws(() => new Synthient({ apiKey: " " }), TypeError);
});

test("requires an API key", (t) => {
  setAPIKeyEnv(t, undefined);

  assert.throws(() => new Synthient(), {
    name: "TypeError",
    message: /missing API key: pass apiKey or set SYNTHIENT_API_KEY/,
  });
});

test("rejects invalid options", () => {
  const invalid = [
    { baseURL: "ftp://api.test/v4" },
    { baseURL: "not a url" },
    { baseURL: "/api/v4" },
    { baseURL: "https://api.test/v4?debug=1" },
    { baseURL: "https://api.test/v4#top" },
    { baseURL: "https://user:hunter2@api.test/v4" },
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { maxRetries: Number.NaN },
    { maxRetries: Number.POSITIVE_INFINITY },
    { timeout: 0 },
    { timeout: -1 },
    { timeout: 1.5 },
    { timeout: 2 ** 31 },
    { apiKey: "hunter2\r\nx-injected: 1" },
    { apiKey: "hunter2\u0000" },
    { userAgent: "app\nx-injected: 1" },
  ];
  for (const options of invalid) {
    assert.throws(
      () => new Synthient({ apiKey: API_KEY, ...options }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError || error instanceof RangeError, inspect(options));
        assert.doesNotMatch(error.message, /hunter2/);
        return true;
      },
    );
  }
});

test("sends the documented headers and keeps the base path", async () => {
  const { fetch, requests } = stub(() => json(200, { results: [] }));
  const client = new Synthient({
    apiKey: API_KEY,
    baseURL: "https://api.test/prefix/api/v4/",
    fetch,
    userAgent: "my-app/1.2",
  });

  await client.lookupIPs(["8.8.8.8"]);
  await client.account();

  const [post, get] = requests;
  assert.equal(post?.method, "POST");
  assert.equal(post.url, "https://api.test/prefix/api/v4/lookup/ips");
  assert.equal(post.headers.get("x-api-key"), API_KEY);
  assert.equal(post.headers.get("user-agent"), `synthient-node/${VERSION} my-app/1.2`);
  assert.equal(post.headers.get("accept"), "application/json");
  assert.equal(post.headers.get("content-type"), "application/json");
  assert.equal(get?.url, "https://api.test/prefix/api/v4/account/me");
  assert.equal(get.headers.get("content-type"), null);
  assert.equal(get.body, "");
});

test("an empty query or fragment on the base URL does not swallow the path", async () => {
  const { fetch, requests } = stub(() => json(200, account));

  for (const baseURL of ["https://api.test/api/v4?", "https://api.test/api/v4/#"]) {
    await new Synthient({ apiKey: API_KEY, baseURL, fetch }).account();
  }

  assert.deepEqual(
    requests.map((request) => request.url),
    ["https://api.test/api/v4/account/me", "https://api.test/api/v4/account/me"],
  );
});

test("keeps the API key out of inspection and serialization", () => {
  const client = newClient({ apiKey: "secret-api-key" });

  assert.doesNotMatch(inspect(client, { depth: Infinity, showHidden: true }), /secret-api-key/);
  assert.doesNotMatch(JSON.stringify(client), /secret-api-key/);
});

test("keeps interleaved clients separate", async () => {
  const { fetch, requests } = stub(async (request) => {
    await sleep(5);
    return json(200, { ...IP_INFO, ip: request.headers.get("x-api-key") });
  });
  const first = new Synthient({ apiKey: "first", baseURL: BASE_URL, fetch });
  const second = new Synthient({ apiKey: "second", baseURL: BASE_URL, fetch });

  const results = await Promise.all([
    first.lookupIP("8.8.8.8"),
    second.lookupIP("1.1.1.1"),
    first.lookupIP("8.8.4.4"),
  ]);

  assert.deepEqual(
    results.map((result) => result.ip),
    ["first", "second", "first"],
  );
  assert.equal(requests.length, 3);
});

test("exports the public API", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    "APIConnectionError",
    "APIError",
    "APITimeoutError",
    "DEFAULT_BASE_URL",
    "Feed",
    "Synthient",
    "SynthientError",
    "VERSION",
    "dailyExport",
    "hourlyExport",
    "toDate",
  ]);
  assert.equal(sdk.DEFAULT_BASE_URL, "https://api.synthient.com/api/v4");
});

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});

test("types reject invalid calls", () => {
  const checks = async (client: Synthient) => {
    // @ts-expect-error lookupIP takes a string
    await client.lookupIP(8);
    // @ts-expect-error lookupDomain takes params before options
    await client.lookupDomain("example.com", { signal: AbortSignal.timeout(1) });
    // @ts-expect-error request options have no timeout
    await client.account({ timeout: 5 });
    // @ts-expect-error unknown client option
    new Synthient({ apiKey: API_KEY, retries: 2 });

    const category: ServiceCategory = "SOMETHING_NEW";
    // @ts-expect-error relation is a closed set
    const relation: Organization["relation"] = "GUEST";

    const info: IPInfo = await client.lookupIP("8.8.8.8");
    // @ts-expect-error intelligence is absent when the API has no data
    return [info.intelligence.risk_score, category, relation];
  };
  assert.equal(typeof checks, "function");
});
