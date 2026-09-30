/** Returns the trimmed API key, falling back to the SYNTHIENT_API_KEY environment variable. */
export function resolveAPIKey(apiKey: string | undefined): string {
  return (apiKey ?? process.env.SYNTHIENT_API_KEY ?? "").trim();
}

/** Throws a RangeError unless `timeout` is a whole number of milliseconds setTimeout accepts. */
export function checkTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2 ** 31 - 1) {
    throw new RangeError("timeout must be an integer number of milliseconds from 1 to 2147483647");
  }
}

/** Returns the query parameters for an optional page or result limit. */
export function limitQuery(limit: number | undefined): Record<string, string> {
  if (limit === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return { limit: String(limit) };
}
