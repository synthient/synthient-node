// Prints the honeypot traffic Synthient has observed for a domain. Each lookup costs
// one credit.
//
//   SYNTHIENT_API_KEY=... node examples/lookup-domain.ts example.com
import { Synthient, toDate } from "@synthient/synthient";

const domain = process.argv[2];
if (domain === undefined) {
  throw new Error("usage: lookup-domain.ts <domain>");
}

const info = await new Synthient().lookupDomain(domain, { limit: 5 });

console.log(`${info.domain}: ${info.status}`);
console.log(`events: ${info.stats.events_24h} in 24h, ${info.stats.total_events_30d} in 30d`);
console.log(`unique IPs: ${info.unique_ips.value_24h} in 24h, ${info.unique_ips.value_30d} in 30d`);
if (info.top_asn) {
  console.log(`top network: AS${info.top_asn.asn} (${info.top_asn.events} events)`);
}
for (const event of info.recent_events) {
  const at = toDate(event.timestamp).toISOString();
  console.log(at, event.source_ip_masked, event.target_subdomain, event.country_code, event.port);
}
