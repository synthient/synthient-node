// Looks up several IP addresses in one batch request and prints the risk score and
// categories of each.
//
//   SYNTHIENT_API_KEY=... node examples/lookup-ips.ts 8.8.8.8 1.1.1.1
import { Synthient } from "@synthient/synthient";

const ips = process.argv.slice(2);
if (ips.length === 0) {
  throw new Error("usage: lookup-ips.ts <ip>...");
}

const results = await new Synthient().lookupIPs(ips);

for (const result of results) {
  const score = result.intelligence?.risk_score ?? "-";
  const categories = result.intelligence?.categories.join(", ") ?? "";
  console.log(result.ip, score, categories);
}
