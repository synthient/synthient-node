/**
 * The official Node.js client for the Synthient API: IP and domain intelligence,
 * account details, and real-time and bulk data feeds.
 *
 * @example
 * ```ts
 * import { Synthient } from "@synthient/synthient";
 *
 * const client = new Synthient(); // reads SYNTHIENT_API_KEY
 * const info = await client.lookupIP("8.8.8.8");
 * console.log(info.intelligence?.risk_score);
 * ```
 *
 * @module
 */
export {
  DEFAULT_BASE_URL,
  Synthient,
  type ClientOptions,
  type LookupDomainOptions,
} from "./client.ts";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  SynthientError,
  type APIErrorInit,
} from "./errors.ts";
export type * from "./events.ts";
export { Feed, dailyExport, hourlyExport, type ListExportsOptions } from "./feed.ts";
export type { Fetch, RequestOptions, ResponseMetadata } from "./transport.ts";
export { toDate } from "./types.ts";
export type * from "./types.ts";
export { VERSION } from "./version.ts";
