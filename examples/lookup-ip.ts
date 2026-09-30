// Prints what Synthient knows about an IP address. Each lookup costs one credit.
//
//   SYNTHIENT_API_KEY=... node examples/lookup-ip.ts 8.8.8.8
import { APIError, Synthient, toDate } from "@synthient/synthient";

const ip = process.argv[2];
if (ip === undefined) {
  throw new Error("usage: lookup-ip.ts <ip>");
}

const client = new Synthient();
let info;
try {
  info = await client.lookupIP(ip);
} catch (error) {
  if (error instanceof APIError && error.status === 402) {
    throw new Error("out of lookup credits", { cause: error });
  }
  throw error;
}

console.log("ip:", info.ip);
if (info.network) {
  console.log(`network: ${info.network.isp} (AS${info.network.asn}, ${info.network.type})`);
}
if (info.location) {
  console.log(`location: ${info.location.city}, ${info.location.country}`);
}
if (info.intelligence) {
  console.log("risk score:", info.intelligence.risk_score);
  console.log("categories:", info.intelligence.categories.join(", "));
  for (const provider of info.intelligence.providers) {
    const lastSeen = toDate(provider.last_seen).toISOString();
    console.log(`provider: ${provider.provider} (${provider.type}), last seen ${lastSeen}`);
  }
} else {
  console.log("no intelligence available");
}
