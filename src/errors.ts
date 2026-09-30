import { STATUS_CODES } from "node:http";

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Base class of the errors the SDK throws for failed requests and invalid responses.
 * Invalid arguments and configuration throw `TypeError` or `RangeError` instead, and a
 * canceled request rejects with its `AbortSignal`'s reason.
 */
export class SynthientError extends Error {
  override name = "SynthientError";
}

/**
 * The request got no response, for example because of a DNS, connection, or TLS failure.
 * The underlying error is available as `cause`.
 */
export class APIConnectionError extends SynthientError {
  override name = "APIConnectionError";
}

/**
 * No data arrived for the client's `timeout` while waiting for a response or reading
 * its body.
 */
export class APITimeoutError extends APIConnectionError {
  override name = "APITimeoutError";
}

/** The fields of an {@link APIError}. */
export interface APIErrorInit {
  status: number;
  type?: string | undefined;
  title?: string | undefined;
  detail?: string | undefined;
  errors?: Record<string, string[]> | undefined;
  requestID?: string | undefined;
  retryAfter?: number | undefined;
}

/**
 * The API answered with a non-success HTTP status.
 *
 * `message` contains only the HTTP status, so it is safe to log. The other fields come
 * from the server's problem details and can contain sensitive data.
 */
export class APIError extends SynthientError {
  override name = "APIError";
  /** The HTTP status code, such as 402 when the account is out of credits. */
  readonly status: number;
  /** The problem type URI, such as "https://docs.synthient.com/errors/unauthorized", or "". */
  readonly type: string;
  /** A short summary of the problem type, or "". */
  readonly title: string;
  /** An explanation of this occurrence of the problem, or "". */
  readonly detail: string;
  /** Validation messages by request field, set on 422 responses. */
  readonly errors: Record<string, string[]>;
  /** Identifies the request when contacting Synthient support, or "". */
  readonly requestID: string;
  /** Milliseconds the server asked the caller to wait before retrying, if it said. */
  readonly retryAfter: number | undefined;

  constructor(init: APIErrorInit, options?: ErrorOptions) {
    const text = STATUS_CODES[init.status];
    super(text === undefined ? String(init.status) : `${init.status} ${text}`, options);
    this.status = init.status;
    this.type = init.type ?? "";
    this.title = init.title ?? "";
    this.detail = init.detail ?? "";
    this.errors = init.errors ?? {};
    this.requestID = init.requestID ?? "";
    this.retryAfter = init.retryAfter;
  }
}

/**
 * Builds an APIError from a response and its bounded body. Plain text, HTML, and
 * malformed problem details still keep the status, request ID, and Retry-After.
 */
export function apiError(response: Response, body: Uint8Array, cause?: unknown): APIError {
  let problem: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (isObject(parsed)) {
      problem = parsed;
    }
  } catch {
    // Not problem details; the status and headers still describe the failure.
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  let errors: Record<string, string[]> = {};
  if (isObject(problem.errors)) {
    const entries = Object.entries(problem.errors);
    const valid = entries.every(([, messages]) => {
      return Array.isArray(messages) && messages.every((message) => typeof message === "string");
    });
    if (valid) {
      errors = Object.fromEntries(entries as [string, string[]][]);
    }
  }

  return new APIError(
    {
      status: response.status,
      type: text(problem.type),
      title: text(problem.title),
      detail: text(problem.detail),
      errors,
      requestID: response.headers.get("x-request-id") ?? text(problem.instance),
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Parses a Retry-After header as whole seconds or an IMF-fixdate and returns
 * milliseconds. Negative and past values become 0; absent and malformed values return
 * undefined.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  const value = header?.trim() ?? "";
  if (/^-?\d+$/.test(value)) {
    return Math.min(Math.max(Number(value), 0), 2 ** 31) * 1000;
  }
  if (!IMF_FIXDATE.test(value)) {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(at - Date.now(), 0) : undefined;
}

/** Reports whether a parsed JSON value is an object rather than an array or primitive. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
