const assert = require("node:assert/strict");
const { APIError, Synthient, SynthientError, VERSION } = require("@synthient/synthient");

const client = new Synthient({ apiKey: "key" });
assert.equal(typeof client.lookupIP, "function");
assert.ok(new APIError({ status: 404 }) instanceof SynthientError);
console.log("cjs ok", VERSION);
