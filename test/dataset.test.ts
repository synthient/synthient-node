import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_KEY,
  BASE_URL,
  collect,
  json,
  newClient,
  redirect,
  redirectTo,
  serve,
  stub,
  type Recorded,
} from "./helpers.ts";

const GEOLOCATION_EXPORT = {
  id: "2026-11-17",
  kind: "daily",
  date: "2026-11-17",
  size_bytes: 466431938,
  row_count: 27456467,
  checksum: "9712",
  created_at: 1794960045,
  download_path: "/api/v4/feeds/geolocation/export/2026-11-17",
  formats: [
    { format: "parquet", size_bytes: 466431938, checksum: "9712" },
    { format: "csv", size_bytes: 540196440, checksum: "de74" },
    { format: "mmdb", size_bytes: 1874587084, checksum: "ae71" },
  ],
};

const WHOIS_META = {
  id: "latest",
  stream: "whois",
  kind: "daily",
  format: "tar.gz",
  date: 1794873600,
  rows: 23481094,
  size: 997234948,
  checksum: "add0",
  created_at: 1794960929,
  schema: { fields: [] },
  formats: [{ format: "tar.gz", size_bytes: 997234948, checksum: "add0" }],
  entities: [
    {
      entity: "asns",
      row_count: 123778,
      size_bytes: 5442736,
      checksum: "062f",
      schema: {
        fields: [
          { name: "asn", type: "int64" },
          { name: "updated", type: "timestamp" },
        ],
      },
    },
    {
      entity: "contacts",
      row_count: 6459660,
      size_bytes: 205447373,
      checksum: "cf61",
      schema: { fields: [{ name: "emails", type: "list<string>" }] },
    },
    { entity: "registrars", row_count: 1, size_bytes: 2, checksum: "0a0b" },
  ],
};

function datasetStub() {
  return stub((request: Recorded) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/export")) {
      return json(200, { stream: "geolocation", feeds: [GEOLOCATION_EXPORT] });
    }
    if (path.endsWith("/export/daily")) {
      return json(200, { stream: "geolocation", days: [] });
    }
    if (path.endsWith("/meta")) {
      return json(200, WHOIS_META);
    }
    return redirect("https://storage.test/x");
  });
}

test("datasets use their routes", async () => {
  const { fetch, requests } = datasetStub();
  const client = newClient({ fetch });

  for (const dataset of [client.geolocation, client.whois]) {
    assert.deepEqual((await dataset.listExports()).feeds, [GEOLOCATION_EXPORT]);
    await dataset.exportVolume({ days: 30 });
    await dataset.exportMeta("latest");
    await dataset.downloadURL("2026-11-17");
  }

  assert.deepEqual(
    requests.map((request) => request.url.slice(BASE_URL.length)),
    ["geolocation", "whois"].flatMap((name) => [
      `/feeds/${name}/export`,
      `/feeds/${name}/export/daily?days=30`,
      `/feeds/${name}/export/latest/meta`,
      `/feeds/${name}/export/2026-11-17`,
    ]),
  );
});

test("dataset format is sent only when set", async () => {
  const { fetch, requests } = datasetStub();
  const client = newClient({ fetch });

  await client.geolocation.exportMeta("latest", { format: "mmdb" });
  await client.geolocation.downloadURL("2026-11-17", { format: "csv" });
  await client.geolocation.exportMeta("latest", { format: undefined });
  await client.whois.downloadURL("latest", { format: "tar.gz" });

  assert.deepEqual(
    requests.map((request) => request.url.slice(BASE_URL.length)),
    [
      "/feeds/geolocation/export/latest/meta?format=mmdb",
      "/feeds/geolocation/export/2026-11-17?format=csv",
      "/feeds/geolocation/export/latest/meta",
      "/feeds/whois/export/latest?format=tar.gz",
    ],
  );
});

test("dataset export IDs are latest or a UTC day", async () => {
  const { fetch, requests } = datasetStub();
  const dataset = newClient({ fetch }).geolocation;

  await dataset.exportMeta("latest");
  await dataset.exportMeta("2026-11-17");
  for (const id of ["2026-11-17/3", "2026-11-17/03", "daily", "2026-02-30", ""]) {
    await assert.rejects(dataset.exportMeta(id), TypeError, id);
    await assert.rejects(dataset.downloadURL(id), TypeError, id);
    await assert.rejects(dataset.download(id), TypeError, id);
  }

  assert.equal(requests.length, 2);
});

test("dataset listings send day on every page", async () => {
  const { fetch, requests } = stub((request) => {
    const next = new URL(request.url).searchParams.has("cursor") ? null : "c1";
    return json(200, { stream: "whois", feeds: [GEOLOCATION_EXPORT], next_cursor: next });
  });

  await collect(newClient({ fetch }).whois.allExports({ day: "2026-11-17" }));

  assert.deepEqual(
    requests.map((request) => new URL(request.url).search),
    ["?day=2026-11-17", "?cursor=c1&day=2026-11-17"],
  );
});

test("a WHOIS meta keeps its entities and reads a null schema as empty", async () => {
  for (const fields of [[], null]) {
    const body = {
      ...WHOIS_META,
      schema: { fields },
      entities: [...WHOIS_META.entities, { ...WHOIS_META.entities[0], schema: { fields } }],
    };
    const { fetch } = stub(() => json(200, body));

    const meta = await newClient({ fetch }).whois.exportMeta("latest");

    assert.deepEqual(meta.schema, { fields: [] });
    assert.deepEqual(meta.entities, [
      ...WHOIS_META.entities,
      { ...WHOIS_META.entities[0], schema: { fields: [] } },
    ]);
  }
});

test("dataset metas pass every format and column type through", async () => {
  for (const format of ["parquet", "csv", "mmdb", "tar.gz", "zip"]) {
    const body = {
      id: "2026-11-17",
      stream: "geolocation",
      kind: "daily",
      format,
      date: 1794873600,
      rows: 27456467,
      size: 466431938,
      checksum: "9712",
      created_at: 1794960045,
      schema: {
        fields: ["double", "int32", "date", "float"].map((type) => ({ name: type, type })),
      },
      formats: GEOLOCATION_EXPORT.formats,
    };
    const { fetch } = stub(() => json(200, body));

    assert.deepEqual(await newClient({ fetch }).geolocation.exportMeta("latest"), body);
  }
});

test("dataset downloads keep the API key away from storage", async (t) => {
  const storage = await serve(t, (_, res) => {
    res.end("MMDB bytes");
  });
  const api = await redirectTo(t, `${storage.origin}/geolocation/2026-11-17.mmdb?sig=secret`);

  const body = await newClient({ baseURL: api.baseURL }).geolocation.download("2026-11-17", {
    format: "mmdb",
  });

  assert.equal(await new Response(body).text(), "MMDB bytes");
  assert.equal(api.requests[0]?.url, "/api/v4/feeds/geolocation/export/2026-11-17?format=mmdb");
  assert.equal(api.requests[0].headers["x-api-key"], API_KEY);
  assert.equal(storage.requests[0]?.headers["x-api-key"], undefined);
});
