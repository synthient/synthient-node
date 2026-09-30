// Lists the newest exports of the proxies feed, then downloads the most recent daily
// export to proxies.parquet and verifies its checksum. It needs an API key with the
// PROXY_FEEDS scope.
//
//   SYNTHIENT_API_KEY=... node examples/download-export.ts
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Synthient, type Export } from "@synthient/synthient";

const client = new Synthient();

let daily: Export | undefined;
for await (const item of client.proxies.allExports()) {
  console.log(
    item.id.padEnd(16),
    item.kind.padEnd(6),
    `${item.row_count} rows`,
    `${item.size_bytes} bytes`,
  );
  if (item.kind === "daily") {
    daily = item;
    break;
  }
}
if (!daily) {
  throw new Error("no daily export found");
}

const hash = createHash("sha256");
const body = await client.proxies.download(daily.id);
await pipeline(
  Readable.fromWeb(body),
  new Transform({
    transform(chunk: Buffer, _, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }),
  createWriteStream("proxies.parquet"),
);

if (hash.digest("hex") !== daily.checksum) {
  throw new Error("checksum mismatch");
}
console.log("saved", daily.id, "to proxies.parquet");
