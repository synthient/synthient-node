/** Rejects a key that a header cannot carry, without putting the key in the error message. */
export function resolveAPIKey(apiKey: string | undefined): string {
  const key = (apiKey ?? process.env.SYNTHIENT_API_KEY ?? "").trim();
  if (/[^\x20-\x7e]/.test(key)) {
    throw new TypeError("invalid API key: it must be printable ASCII");
  }
  return key;
}

/** The upper bound is the longest delay setTimeout accepts. */
export function checkTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2 ** 31 - 1) {
    throw new RangeError("timeout must be an integer number of milliseconds from 1 to 2147483647");
  }
}

export function limitQuery(limit: number | undefined): Record<string, string> {
  if (limit === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return { limit: String(limit) };
}
