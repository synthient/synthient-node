import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_URL, json, newClient, problem, stub } from "./helpers.ts";

const ACCOUNT = {
  email: "dev@example.com",
  first_name: "Dev",
  last_name: "Eloper",
  organization: { id: "0b0e3c1e-8f4c-4d8e-9d2a-6c3f1b2a4e5d", name: "Example", relation: "OWNER" },
  scopes: ["BASIC", "PROXY_FEEDS"],
  lookup_quota: { credits: 1000, resets_in: 3600 },
  api_key: { id: "key-id", name: "sdk", created_at: "2026-09-28T19:04:52.463869Z" },
};

test("account returns the account as sent", async () => {
  const { fetch, requests } = stub(() => json(200, ACCOUNT));

  const account = await newClient({ fetch }).account();

  assert.deepEqual(account, ACCOUNT);
  assert.equal(account.api_key.created_at, "2026-09-28T19:04:52.463869Z");
  assert.equal(requests[0]?.url, `${BASE_URL}/account/me`);
});

test("account decodes new scopes and a null api_key as absent", async () => {
  const scopes = [
    "GEOLOCATION_FEED",
    "WHOIS_FEED",
    "WHOIS_STREAM",
    "HELIOS",
    "NETWORK_IOCS_FEED",
    "NETWORK_IOCS_STREAM",
    "FILE_IOCS_FEED",
    "FILE_IOCS_STREAM",
    "SOMETHING_NEW",
  ];
  const { fetch } = stub(() => json(200, { ...ACCOUNT, scopes, api_key: null }));

  const account = await newClient({ fetch }).account();

  assert.deepEqual(account.scopes, scopes);
  assert.equal("api_key" in account, false);
});

test("health resolves when the API is healthy", async () => {
  const { fetch, requests } = stub(() => json(200, { status: "ok" }));

  await newClient({ fetch }).health();
  assert.equal(requests[0]?.url, `${BASE_URL}/health`);
});

test("health rejects an unhealthy API without retrying", async () => {
  const { fetch, requests } = stub(() => problem(503, { title: "Service Unavailable" }));

  await assert.rejects(newClient({ fetch }).health(), { name: "APIError", status: 503 });
  assert.equal(requests.length, 1);
});
