import { setTimeout as sleep } from "node:timers/promises";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  SynthientError,
  apiError,
  isObject,
  parseRetryAfter,
} from "./errors.ts";

const MAX_RESPONSE_SIZE = 16 << 20;
const MAX_ERROR_SIZE = 64 << 10;
const MAX_BACKOFF = 30_000;
const MAX_RETRY_AFTER = 60_000;
const MAX_STORAGE_REDIRECTS = 10;

// Transport failures retried on account and feed requests, matched anywhere in the
// error's cause chain, including errors from a custom fetch. Anything else, such as a
// TLS certificate error, is not retried.
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const RETRY_STATUSES = new Set([500, 502, 503, 504]);

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ResponseMetadata {
  status: number;
  /** The X-Request-Id header, or "". */
  requestID: string;
  /**
   * A copy of the response headers, including RateLimit-Limit, RateLimit-Remaining,
   * and RateLimit-Reset when present. Headers can contain sensitive data, such as
   * presigned download URLs.
   */
  headers: Headers;
}

export interface RequestOptions {
  /**
   * Cancels the call, which rejects with the signal's reason. Use `AbortSignal.timeout(ms)`
   * to bound a whole call, including retries.
   */
  signal?: AbortSignal | undefined;
}

export type Wait = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

// Tests replace the backoff wait through this key in the client options.
export const kWait: unique symbol = Symbol("synthient.wait");

export interface TransportConfig {
  apiKey: string;
  baseURL: URL;
  maxRetries: number;
  timeout: number;
  fetch: Fetch;
  userAgent: string;
  onResponse: ((metadata: ResponseMetadata) => void) | undefined;
  wait: Wait;
}

export interface Request {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: string;
  accept?: string;
  // "transient" retries rate limits, server errors, and transport failures, for
  // requests that cost no credits. "rateLimit" retries only rate limits, which the API
  // returns before doing any work, so a billed lookup is never charged twice.
  policy: "transient" | "rateLimit";
}

/**
 * Its signal follows the caller's signal and an idle timer that runs only while the
 * attempt waits on the network.
 */
export class Attempt {
  readonly caller: AbortSignal | undefined;
  readonly signal: AbortSignal;
  readonly #timer = new AbortController();
  readonly #timeout: number;
  readonly #surface: "api" | "storage";

  constructor(
    caller: AbortSignal | undefined,
    timeout: number,
    surface: "api" | "storage" = "api",
  ) {
    this.caller = caller;
    this.#timeout = timeout;
    this.#surface = surface;
    this.signal = caller ? AbortSignal.any([caller, this.#timer.signal]) : this.#timer.signal;
  }

  /**
   * Storage failures are rebuilt without their message or cause, either of which can
   * contain the presigned URL.
   */
  async watch<T>(work: Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      this.#timer.abort();
    }, this.#timeout);
    try {
      const result = await work;
      this.caller?.throwIfAborted();
      return result;
    } catch (error) {
      if (this.caller?.aborted) {
        throw this.caller.reason;
      }
      if (
        this.#timer.signal.aborted ||
        (this.#surface === "storage" && error instanceof APITimeoutError)
      ) {
        throw new APITimeoutError("request timed out");
      }
      if (this.#surface === "storage") {
        throw new APIConnectionError("connection failed");
      }
      if (error instanceof SynthientError) {
        throw error;
      }
      throw new APIConnectionError("connection failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class Transport {
  readonly #config: TransportConfig;
  readonly #base: string;
  readonly #headers: Headers;

  constructor(config: TransportConfig) {
    this.#config = config;
    this.#base = (config.baseURL.origin + config.baseURL.pathname).replace(/\/+$/, "");
    this.#headers = new Headers({ "x-api-key": config.apiKey, "user-agent": config.userAgent });
  }

  url(request: Request): string {
    const search = new URLSearchParams(request.query).toString();
    return search ? `${this.#base}${request.path}?${search}` : this.#base + request.path;
  }

  /** The caller must read or cancel the returned response's body. */
  send(request: Request, signal?: AbortSignal): Promise<[Response, Attempt]> {
    return this.#request<[Response, Attempt]>(request, signal, (response, attempt) => [
      response,
      attempt,
    ]);
  }

  async #request<T>(
    request: Request,
    signal: AbortSignal | undefined,
    consume: (response: Response, attempt: Attempt) => T | Promise<T>,
  ): Promise<T> {
    const url = this.url(request);
    const headers = new Headers(this.#headers);
    headers.set("accept", request.accept ?? "application/json");
    if (request.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const canRetry = attempt < this.#config.maxRetries;
      const current = new Attempt(signal, this.#config.timeout);

      let delay = backoff(attempt);
      try {
        const response = await current.watch(
          this.#fetch(url, {
            method: request.method ?? "GET",
            headers,
            body: request.body ?? null,
            redirect: "manual",
            signal: current.signal,
          }),
        );
        this.#notify(response);

        // A 429 without Retry-After is a spent monthly budget or concurrent stream
        // limit, which a retry cannot fix.
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const retryStatus =
          (response.status === 429 && retryAfter !== undefined) ||
          (request.policy === "transient" && RETRY_STATUSES.has(response.status));
        if (!canRetry || !retryStatus || (retryAfter ?? 0) > MAX_RETRY_AFTER) {
          return await consume(response, current);
        }
        await drain(response, current);
        delay = Math.max(delay, retryAfter ?? 0);
      } catch (error) {
        if (!canRetry || request.policy !== "transient" || !transient(error, signal)) {
          throw error;
        }
      }
      await this.#config.wait(delay, signal);
    }
  }

  json<T extends object>(request: Request, signal?: AbortSignal): Promise<T> {
    return this.#request(request, signal, async (response, attempt) => {
      if (!response.ok) {
        throw await this.error(response, attempt);
      }
      const [body, complete] = await read(response, attempt, MAX_RESPONSE_SIZE);
      if (!complete) {
        throw new SynthientError(`response body exceeds ${MAX_RESPONSE_SIZE} bytes`);
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw new SynthientError("invalid JSON in response", { cause: error });
      }
      if (!isObject(value)) {
        throw new SynthientError("response is not a JSON object");
      }
      // The client trusts the API's schema; only protocol control data is validated.
      return value as T;
    });
  }

  async stream(request: Request, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const [response, attempt] = await this.send(request, signal);
    if (response.status !== 200) {
      throw await this.error(response, attempt);
    }
    return watchedBody(response, attempt);
  }

  async error(response: Response, attempt: Attempt): Promise<APIError> {
    try {
      const [body] = await read(response, attempt, MAX_ERROR_SIZE);
      return apiError(response, body);
    } catch (error) {
      if (attempt.caller?.aborted) {
        throw error;
      }
      return apiError(response, new Uint8Array(), error);
    }
  }

  /**
   * The API key is never sent to the storage host. Errors never include the presigned
   * URL, and storage error bodies are discarded.
   */
  async download(start: URL, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let url = start;
    for (let redirects = 0; ; redirects++) {
      signal?.throwIfAborted();
      const attempt = new Attempt(signal, this.#config.timeout, "storage");
      const response = await attempt.watch(
        this.#fetch(url.href, {
          headers: { "user-agent": this.#config.userAgent },
          redirect: "manual",
          signal: attempt.signal,
        }),
      );

      if (response.status === 200) {
        return watchedBody(response, attempt);
      }
      await drain(response, attempt);
      if (response.status < 300 || response.status > 399) {
        throw new APIError({
          status: response.status,
          retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        });
      }
      if (redirects === MAX_STORAGE_REDIRECTS) {
        throw new SynthientError("too many export redirects");
      }
      url = redirectTarget(url, response);
    }
  }

  // A custom fetch that throws synchronously still rejects, so watch() wraps its error.
  async #fetch(url: string, init: RequestInit): Promise<Response> {
    return this.#config.fetch(url, init);
  }

  #notify(response: Response): void {
    const hook = this.#config.onResponse;
    if (!hook) {
      return;
    }
    try {
      hook({
        status: response.status,
        requestID: response.headers.get("x-request-id") ?? "",
        headers: new Headers(response.headers),
      });
    } catch (error) {
      process.emitWarning(error instanceof Error ? error : String(error));
    }
  }
}

export function isHTTP(url: URL | null): url is URL {
  return url?.protocol === "https:" || url?.protocol === "http:";
}

export function redirectTarget(from: URL, response: Response): URL {
  const location = response.headers.get("location");
  const target = location === null ? null : URL.parse(location, from.href);
  if (!isHTTP(target) || target.username || target.password) {
    throw new SynthientError("export redirect has no valid location");
  }
  if (from.protocol === "https:" && target.protocol !== "https:") {
    throw new SynthientError("export redirect does not use https");
  }
  return target;
}

export async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    // timers/promises rejects with an AbortError, not the signal's reason.
    throw signal?.aborted ? signal.reason : error;
  }
}

export function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 5), MAX_BACKOFF) * (0.75 + Math.random() / 2);
}

function transient(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (error instanceof APITimeoutError) {
    return true;
  }
  if (!(error instanceof APIConnectionError)) {
    return false;
  }
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 8 && typeof cause === "object" && cause !== null; depth++) {
    if ("code" in cause && TRANSIENT_CODES.has(String(cause.code))) {
      return true;
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

function watchedBody(response: Response, attempt: Attempt): ReadableStream<Uint8Array> {
  if (!response.body) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await attempt.watch(reader.read());
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Returns false with the first `limit` bytes when the body is longer than `limit`. */
async function read(
  response: Response,
  attempt: Attempt,
  limit: number,
): Promise<[Uint8Array, boolean]> {
  if (!response.body) {
    return [new Uint8Array(), true];
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await attempt.watch(reader.read());
      if (done) {
        return [Buffer.concat(chunks, size), true];
      }
      if (size + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - size));
        return [Buffer.concat(chunks, limit), false];
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Discards a body so its connection can be reused. */
export async function drain(response: Response, attempt: Attempt): Promise<void> {
  await read(response, attempt, MAX_ERROR_SIZE).catch(() => undefined);
  attempt.caller?.throwIfAborted();
}
