// Prints the account that owns the API key, its scopes, and its remaining lookup credits.
//
//   SYNTHIENT_API_KEY=... node examples/account.ts
import { Synthient } from "@synthient/synthient";

const account = await new Synthient().account();

console.log(`${account.first_name} ${account.last_name} <${account.email}>`);
console.log("organization:", account.organization.name);
console.log("scopes:", account.scopes.join(", "));
console.log(
  `credits: ${account.lookup_quota.credits} (resets in ${account.lookup_quota.resets_in}s)`,
);
