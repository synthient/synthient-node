// Downloads the newest day of the geolocation dataset as a MaxMind DB to geolocation.mmdb
// and verifies its checksum. It needs an API key with the GEOLOCATION_FEED scope.
//
//   SYNTHIENT_API_KEY=... node examples/download-dataset.ts
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Synthient } from "@synthient/synthient";

const client = new Synthient();

const { feeds } = await client.geolocation.listExports({ limit: 1 });
const newest = feeds[0];
const file = newest?.formats.find((candidate) => candidate.format === "mmdb");
if (!newest || !file) {
  throw new Error("no mmdb file found");
}

const hash = createHash("sha256");
const body = await client.geolocation.download(newest.id, { format: "mmdb" });
await pipeline(
  Readable.fromWeb(body),
  new Transform({
    transform(chunk: Buffer, _, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }),
  createWriteStream("geolocation.mmdb"),
);

if (hash.digest("hex") !== file.checksum) {
  throw new Error("checksum mismatch");
}
console.log("saved", newest.id, "to geolocation.mmdb");
