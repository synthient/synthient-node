import assert from "node:assert/strict";
import { test } from "node:test";
import { SynthientError, dailyExport, hourlyExport } from "../src/index.ts";
import { BASE_URL, EXPORT, collect, json, newClient, problem, stub } from "./helpers.ts";

const META = {
  id: "2026-05-07",
  stream: "proxies",
  kind: "daily",
  format: "parquet",
  date: 1778112000,
  hour: null,
  rows: 1200,
  size: 1048576,
  checksum: "ab12",
  created_at: 1778187600,
  schema: { fields: [{ name: "ip", type: "string" }] },
};

function page(ids: string[], nextCursor?: string | null) {
  return {
    stream: "proxies",
    feeds: ids.map((id) => ({ ...EXPORT, id })),
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
}

test("export IDs map to unpadded URL paths", async () => {
  const { fetch, requests } = stub(() => json(200, META));
  const feed = newClient({ fetch }).proxies;
  const cases = [
    ["latest", "latest"],
    ["2026-05-07", "2026-05-07"],
    ["2026-05-07/21", "2026-05-07/21"],
    ["2026-05-07/07", "2026-05-07/7"],
    ["2026-05-07/0", "2026-05-07/0"],
    ["2024-02-29", "2024-02-29"],
  ] as const;

  for (const [id] of cases) {
    assert.deepEqual(await feed.exportMeta(id), META);
  }

  assert.deepEqual(
    requests.map((request) => request.url),
    cases.map(([, path]) => `${BASE_URL}/feeds/proxies/export/${path}/meta`),
  );
});

test("invalid export IDs send nothing", async () => {
  const { fetch, requests } = stub(() => json(200, META));
  const feed = newClient({ fetch }).proxies;
  const invalid = [
    "",
    "yesterday",
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-5-7",
    "2026-05-07/",
    "2026-05-07/24",
    "2026-05-07/123",
    "2026-05-07T21",
    "../2026-05-07",
    "latest/1",
  ];

  for (const id of invalid) {
    await assert.rejects(feed.exportMeta(id), TypeError, id);
    await assert.rejects(feed.downloadURL(id), TypeError, id);
  }
  assert.equal(requests.length, 0);
});

test("dailyExport and hourlyExport use UTC", () => {
  const date = new Date("2026-05-07T23:30:00-05:00");

  assert.equal(dailyExport(date), "2026-05-08");
  assert.equal(hourlyExport(date), "2026-05-08/4");
  assert.equal(hourlyExport(new Date("2026-05-07T21:00:00Z")), "2026-05-07/21");
  assert.throws(() => dailyExport(new Date(Number.NaN)), RangeError);
});

test("each feed uses its route", async () => {
  const { fetch, requests } = stub(() => json(200, page([])));
  const client = newClient({ fetch });
  const feeds = [
    [client.proxies, "proxies"],
    [client.anonymizers, "anonymizers"],
    [client.torrents, "torrents"],
    [client.ja4t, "ja4t"],
    [client.heliosHTTP, "helio/http"],
    [client.heliosHTTPS, "helio/https"],
    [client.heliosDNS, "helio/dns"],
    [client.heliosADB, "helio/adb"],
  ] as const;

  for (const [feed] of feeds) {
    await feed.listExports();
  }

  assert.deepEqual(
    requests.map((request) => request.url),
    feeds.map(([, path]) => `${BASE_URL}/feeds/${path}/export`),
  );
});

test("listExports sends its parameters and validates the page", async () => {
  const { fetch, requests } = stub(() => json(200, page(["2026-05-07/21"], "next")));
  const feed = newClient({ fetch }).proxies;

  const result = await feed.listExports({ limit: 2, cursor: "abc" });
  await feed.listExports({ cursor: "" });

  assert.equal(result.next_cursor, "next");
  assert.equal(result.feeds[0]?.id, "2026-05-07/21");
  assert.equal(requests[0]?.url, `${BASE_URL}/feeds/proxies/export?limit=2&cursor=abc`);
  assert.equal(requests[1]?.url, `${BASE_URL}/feeds/proxies/export`);
  await assert.rejects(feed.listExports({ limit: 0 }), RangeError);
  assert.equal(requests.length, 2);
});

test("listExports accepts every last-page form and rejects bad control data", async () => {
  for (const cursor of [undefined, null, ""]) {
    const { fetch } = stub(() => json(200, page([], cursor)));
    await newClient({ fetch }).proxies.listExports();
  }
  for (const body of [{ stream: "proxies" }, { ...page([]), next_cursor: 5 }]) {
    const { fetch } = stub(() => json(200, body));
    await assert.rejects(newClient({ fetch }).proxies.listExports(), SynthientError);
  }
});

test("allExports fetches pages lazily, through empty pages", async () => {
  const pages = [page(["a"], "c1"), page([], "c2"), page(["b", "c"], null)];
  const { fetch, requests } = stub((_, index) => json(200, pages[index]));
  const params = { limit: 1 };

  const iterator = newClient({ fetch }).proxies.allExports(params);
  params.limit = 99;
  assert.equal(requests.length, 0);

  const ids = (await collect(iterator)).map((item) => item.id);

  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).search),
    ["?limit=1", "?limit=1&cursor=c1", "?limit=1&cursor=c2"],
  );
});

test("allExports stops on break without fetching more", async () => {
  const { fetch, requests } = stub(() => json(200, page(["a", "b"], "next")));

  for await (const item of newClient({ fetch }).proxies.allExports()) {
    assert.equal(item.id, "a");
    break;
  }

  assert.equal(requests.length, 1);
});

test("allExports reports repeated cursors and later page errors", async () => {
  const cases = [
    [[page(["a"], "c1"), page(["b"], "c1")], undefined],
    [[page(["a"], "start")], "start"],
  ] as const;
  for (const [pages, cursor] of cases) {
    const { fetch } = stub((_, index) => json(200, pages[index]));
    const seen: string[] = [];

    await assert.rejects(async () => {
      for await (const item of newClient({ fetch }).proxies.allExports({ cursor })) {
        seen.push(item.id);
      }
    }, /repeated cursor/);
    assert.ok(seen.length > 0);
  }

  const { fetch } = stub((_, index) => (index === 0 ? json(200, page(["a"], "c1")) : problem(500)));
  const seen: string[] = [];
  await assert.rejects(
    async () => {
      for await (const item of newClient({ fetch, maxRetries: 0 }).proxies.allExports()) {
        seen.push(item.id);
      }
    },
    { status: 500 },
  );
  assert.deepEqual(seen, ["a"]);
});
