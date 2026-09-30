import { SynthientError, isObject } from "./errors.ts";
import { limitQuery } from "./options.ts";
import { drain, type RequestOptions, type Transport } from "./transport.ts";
import type { Export, ExportMeta, ExportPage } from "./types.ts";

const MAX_EVENT_SIZE = 16 << 20;
const EXPORT_ID = /^(\d{4})-(\d{2})-(\d{2})(?:\/(\d{1,2}))?$/;

/** Optional parameters for listing exports. */
export interface ListExportsParams {
  /** The page size. The API default is 100, and it clamps values above 500. */
  limit?: number | undefined;
  /** Continues a listing from a previous page's `next_cursor`. */
  cursor?: string | undefined;
}

/**
 * Returns the ID of the daily export for the UTC day containing `date`. Daily exports
 * roll up a day's hourly exports once the day ends.
 */
export function dailyExport(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns the ID of the hourly export for the UTC hour containing `date`, with the hour
 * unpadded as in `Export.id`.
 */
export function hourlyExport(date: Date): string {
  return `${dailyExport(date)}/${date.getUTCHours()}`;
}

/**
 * A Synthient data feed. Each feed has a real-time stream of events of type `T` and
 * hourly parquet exports that roll up into daily exports. Access feeds through the
 * client, such as `client.proxies`.
 *
 * Export IDs are "latest" for the most recent hourly export, a UTC day as
 * "YYYY-MM-DD", or a UTC hour as "YYYY-MM-DD/H" (a zero-padded hour is also accepted).
 * `Export.id` values and the results of {@link dailyExport} and {@link hourlyExport} can
 * be passed as they are.
 */
export class Feed<T> {
  readonly #transport: Transport;
  readonly #path: string;

  /** @internal Feeds are created by the client. */
  constructor(transport: Transport, path: string) {
    this.#transport = transport;
    this.#path = path;
  }

  /**
   * Streams the feed's real-time events. The connection opens on the first `next()`,
   * so connection errors are thrown there, including an APIError with status 403 for a
   * missing scope or 429 for too many concurrent streams.
   * The server closes each stream after about 30 minutes, which ends the iteration
   * normally; any other failure throws. Breaking out of the loop closes the connection.
   *
   * The API has no resume cursor, so events sent between connections are missed. Call
   * `stream` again to reconnect. The client's `timeout` bounds the gap between data,
   * and the server sends a keepalive about every 15 seconds.
   */
  async *stream(options?: RequestOptions): AsyncGenerator<T, void, undefined> {
    const body = await this.#transport.stream(
      { path: `${this.#path}/stream`, accept: "application/x-ndjson", policy: "transient" },
      options?.signal,
    );
    yield* ndjson<T>(body);
  }

  /** Returns one page of the feed's exports, newest first. Use `allExports` to iterate every page. */
  async listExports(params?: ListExportsParams, options?: RequestOptions): Promise<ExportPage> {
    const query = limitQuery(params?.limit);
    if (params?.cursor) {
      query.cursor = params.cursor;
    }

    const page = await this.#transport.json<ExportPage>(
      { path: `${this.#path}/export`, query, policy: "transient" },
      options?.signal,
    );
    const cursor: unknown = page.next_cursor;
    if (!Array.isArray(page.feeds)) {
      throw new SynthientError("export page has no feeds array");
    }
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
      throw new SynthientError("export page has an invalid next_cursor");
    }
    return page;
  }

  /**
   * Iterates over the feed's exports, newest first, fetching pages lazily as iteration
   * proceeds. Breaking out of the loop fetches no more pages. `params` is copied when
   * `allExports` is called; errors, including invalid parameters, are thrown from the
   * iteration.
   */
  allExports(
    params?: ListExportsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Export, void, undefined> {
    return this.#allExports(params?.limit, params?.cursor, options);
  }

  async *#allExports(
    limit: number | undefined,
    cursor: string | undefined,
    options: RequestOptions | undefined,
  ): AsyncGenerator<Export, void, undefined> {
    const seen = new Set([cursor ?? ""]);
    for (;;) {
      const page = await this.listExports({ limit, cursor }, options);
      yield* page.feeds;
      if (!page.next_cursor) {
        return;
      }
      if (seen.has(page.next_cursor)) {
        throw new SynthientError("export listing returned a repeated cursor");
      }
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }

  /** Returns the checksum, size, row count, and parquet schema of an export. */
  async exportMeta(id: string, options?: RequestOptions): Promise<ExportMeta> {
    return this.#transport.json<ExportMeta>(
      { path: `${this.#path}/export/${exportPath(id)}/meta`, policy: "transient" },
      options?.signal,
    );
  }

  /**
   * Returns a presigned URL for an export's parquet file, for tools that read parquet
   * over HTTPS directly. The URL is valid for 24 hours and grants access without an API
   * key, so treat it as a secret.
   */
  async downloadURL(id: string, options?: RequestOptions): Promise<URL> {
    const [response, attempt] = await this.#transport.send(
      { path: `${this.#path}/export/${exportPath(id)}`, policy: "transient" },
      options?.signal,
    );
    if (response.status >= 400) {
      throw await this.#transport.error(response, attempt);
    }
    await drain(response, attempt);
    if (response.status < 300) {
      throw new SynthientError(`expected a redirect to the export, got status ${response.status}`);
    }

    const header = response.headers.get("location");
    const location = header === null ? null : URL.parse(header, response.url || undefined);
    if (!location || location.username || location.password) {
      throw new SynthientError("export redirect has no valid location");
    }
    if (location.protocol !== "https:" && location.protocol !== this.#transport.baseURL.protocol) {
      throw new SynthientError("export redirect does not use https");
    }
    return location;
  }

  /**
   * Downloads an export's parquet file as a byte stream. Read it to the end or cancel it
   * to release the connection. The API key is sent only to the Synthient API, never to
   * the storage host that serves the file, and errors never include the presigned URL.
   * A non-success response from either returns an APIError.
   */
  async download(id: string, options?: RequestOptions): Promise<ReadableStream<Uint8Array>> {
    const url = await this.downloadURL(id, options);
    return this.#transport.download(url, options?.signal);
  }
}

/**
 * Converts an export ID to its URL path: "latest", "YYYY-MM-DD", or "YYYY-MM-DD/H" with
 * the hour unpadded.
 */
function exportPath(id: string): string {
  if (id === "latest") {
    return id;
  }
  const match = EXPORT_ID.exec(id);
  if (match) {
    const [, year, month, day, hour] = match;
    // An invalid day or an hour past 23 rolls the date over, so it no longer matches.
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0)),
    );
    if (dailyExport(date) === id.slice(0, 10)) {
      return hour === undefined ? dailyExport(date) : hourlyExport(date);
    }
  }
  throw new TypeError("invalid export ID");
}

/**
 * Parses an NDJSON body into its JSON object events, skipping blank lines. Canceling
 * the iteration cancels the body.
 */
async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let size = 0;
  const append = (part: Uint8Array) => {
    if (part.byteLength === 0) {
      return;
    }
    pending.push(part);
    size += part.byteLength;
    if (size > MAX_EVENT_SIZE) {
      throw new SynthientError(`stream event exceeds ${MAX_EVENT_SIZE} bytes`);
    }
  };
  const flush = (): T | undefined => {
    const bytes = pending.length === 1 ? pending[0] : Buffer.concat(pending, size);
    pending = [];
    size = 0;
    const line = decoder.decode(bytes).trim();
    if (line === "") {
      return undefined;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new SynthientError("invalid stream event", { cause: error });
    }
    if (!isObject(event)) {
      throw new SynthientError("stream event is not a JSON object");
    }
    return event as T;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      let start = 0;
      for (let end = value.indexOf(10); end !== -1; end = value.indexOf(10, start)) {
        append(value.subarray(start, end));
        start = end + 1;
        const event = flush();
        if (event !== undefined) {
          yield event;
        }
      }
      append(value.subarray(start));
    }
    const event = flush();
    if (event !== undefined) {
      yield event;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
