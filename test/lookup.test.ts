import assert from "node:assert/strict";
import { test } from "node:test";
import { SynthientError } from "../src/index.ts";
import { BASE_URL, IP_INFO, json, newClient, stub } from "./helpers.ts";

const DOMAIN_INFO = {
  domain: "example.com",
  status: "active",
  stats: { events_24h: 3, total_events_30d: 40 },
  unique_ips: { value_24h: 2, value_30d: 9, sparkline_24h: [0, 1] },
  time_series: [{ date: 1778112000, events: 3, unique_ips: 2 }],
  top_subdomains: [{ subdomain: "www", count: 3 }],
  top_ports: [{ port: 443, count: 3 }],
  geo_distribution: [{ country_code: "US", events: 3, unique_ips: 2 }],
  hour_dow_heatmap: [[0, 1]],
  activity_stats: {
    cadence: "Activity is evenly distributed.",
    median_per_hour: 0,
    p95_per_hour: 1,
    peak_hour: 13,
    quiet_hour: 4,
  },
  recent_events: [
    {
      timestamp: 1778187600,
      source_ip_masked: "203.0.113.7",
      target_subdomain: "www",
      country_code: "US",
      port: 443,
    },
  ],
};

test("lookupIP returns the API's intelligence", async () => {
  const { fetch, requests } = stub(() => json(200, IP_INFO));

  const info = await newClient({ fetch }).lookupIP("8.8.8.8");

  assert.deepEqual(info, IP_INFO);
  assert.equal(requests[0]?.url, `${BASE_URL}/lookup/ip/8.8.8.8`);
});

test("lookupIP escapes the address as a path segment", async () => {
  const { fetch, requests } = stub(() => json(200, IP_INFO));
  const client = newClient({ fetch });

  await client.lookupIP("2001:db8::1");
  await client.lookupIP("::ffff:192.0.2.1");
  await client.lookupIP("fe80::1%eth0");

  assert.deepEqual(
    requests.map((request) => request.url.slice(BASE_URL.length)),
    ["/lookup/ip/2001:db8::1", "/lookup/ip/::ffff:192.0.2.1", "/lookup/ip/fe80::1%25eth0"],
  );
});

test("lookupIP leaves absent sections absent", async () => {
  const { fetch } = stub(() => json(200, { ip: "10.0.0.1" }));

  const info = await newClient({ fetch }).lookupIP("10.0.0.1");

  assert.equal(info.network, undefined);
  assert.equal(info.location, undefined);
  assert.equal(info.intelligence, undefined);
});

test("lookupIP rejects invalid addresses without a request", async () => {
  const { fetch, requests } = stub(() => json(200, IP_INFO));
  const client = newClient({ fetch });

  for (const ip of ["", "not-an-ip", " 8.8.8.8", "8.8.8.8/32", "1.2.3.4?x", "999.1.1.1", 8888]) {
    await assert.rejects(client.lookupIP(ip as string), TypeError);
  }
  assert.equal(requests.length, 0);
});

test("lookupIPs posts the addresses and returns the results", async () => {
  const other = { ...IP_INFO, ip: "1.1.1.1" };
  const { fetch, requests } = stub(() => json(200, { results: [IP_INFO, other] }));
  const addresses = new Set(["8.8.8.8", "1.1.1.1"]);

  const results = await newClient({ fetch }).lookupIPs(addresses);

  assert.deepEqual(results, [IP_INFO, other]);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0].url, `${BASE_URL}/lookup/ips`);
  assert.equal(requests[0].body, '{"ips":["8.8.8.8","1.1.1.1"]}');
  assert.deepEqual([...addresses], ["8.8.8.8", "1.1.1.1"]);
});

test("lookupIPs handles empty and invalid input without a request", async () => {
  const { fetch, requests } = stub(() => json(200, { results: [] }));
  const client = newClient({ fetch });

  assert.deepEqual(await client.lookupIPs([]), []);
  await assert.rejects(client.lookupIPs(["8.8.8.8", "bad"]), {
    name: "TypeError",
    message: "invalid IP address at index 1",
  });
  assert.equal(requests.length, 0);
});

test("lookupIPs rejects a response without results", async () => {
  const { fetch } = stub(() => json(200, { results: null }));

  await assert.rejects(newClient({ fetch }).lookupIPs(["8.8.8.8"]), SynthientError);
});

test("lookupDomain escapes the domain and sends the limit", async () => {
  const { fetch, requests } = stub(() => json(200, DOMAIN_INFO));
  const client = newClient({ fetch });

  const info = await client.lookupDomain("example.com", { limit: 5 });
  assert.deepEqual(info, DOMAIN_INFO);
  assert.equal(info.top_asn, undefined);

  const cases = [
    ["example.com", "example.com"],
    ["a/b", "a%2Fb"],
    ["a?b", "a%3Fb"],
    ["a#b", "a%23b"],
    ["a%b", "a%25b"],
    ["a b", "a%20b"],
    ["...", "..."],
    ["bücher.example", "b%C3%BCcher.example"],
  ] as const;
  for (const [domain] of cases) {
    await client.lookupDomain(domain, { limit: undefined });
  }

  assert.equal(requests[0]?.url, `${BASE_URL}/lookup/domain/example.com?limit=5`);
  assert.deepEqual(
    requests.slice(1).map((request) => request.url.slice(BASE_URL.length)),
    cases.map(([, path]) => `/lookup/domain/${path}`),
  );
});

test("lookupDomain rejects invalid input without a request", async () => {
  const { fetch, requests } = stub(() => json(200, DOMAIN_INFO));
  const client = newClient({ fetch });

  for (const domain of ["", ".", "..", "a\uD800.example"]) {
    await assert.rejects(client.lookupDomain(domain), TypeError);
  }
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(client.lookupDomain("example.com", { limit }), RangeError);
  }
  assert.equal(requests.length, 0);
});
