import assert from "node:assert/strict";
import { APIError, Synthient, SynthientError, VERSION } from "@synthient/synthient";

const client = new Synthient({ apiKey: "key" });
assert.equal(typeof client.lookupIP, "function");
assert.ok(new APIError({ status: 404 }) instanceof SynthientError);
console.log("esm ok", VERSION);
