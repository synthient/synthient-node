import { SynthientError, isObject } from "./errors.ts";
import { limitQuery } from "./options.ts";
import { drain, redirectTarget, type RequestOptions, type Transport } from "./transport.ts";
import type { Export, ExportMeta, ExportPage } from "./types.ts";

const MAX_EVENT_SIZE = 16 << 20;
const EXPORT_ID = /^(\d{4})-(\d{2})-(\d{2})(?:\/(\d{1,2}))?$/;

type Reviver = (key: string, value: unknown, context?: { source: string }) => unknown;

/**
 * Keeps each `tunnel_id` as the exact decimal digits sent on the wire, since these
 * unsigned 64-bit IDs lose precision as numbers above 2^53.
 */
export const exactTunnelID: Reviver = (key, value, context) =>
  key === "tunnel_id" && typeof value === "number" && context ? context.source : value;

export interface ListExportsOptions extends RequestOptions {
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
  readonly #reviver: Reviver | undefined;

  /** @internal Feeds are created by the client. */
  constructor(transport: Transport, path: string, reviver?: Reviver) {
    this.#transport = transport;
    this.#path = path;
    this.#reviver = reviver;
  }

  /**
   * Streams the feed's real-time events. The connection opens on the first `next()`,
   * which throws any connection error, such as an APIError with status 403 for a
   * missing scope. The server closes each stream after up to 30 minutes, which ends the
   * iteration normally; any other failure throws. Breaking out of the loop closes the
   * connection. Events sent between connections are missed, so call `stream` again to
   * reconnect. The client's `timeout` bounds the gap between data, and the server sends
   * a keepalive about every 15 seconds.
   */
  async *stream(options?: RequestOptions): AsyncGenerator<T, void, undefined> {
    const signal = options?.signal;
    const body = await this.#transport.stream(
      { path: `${this.#path}/stream`, accept: "application/x-ndjson", policy: "transient" },
      signal,
    );
    yield* ndjson<T>(body, signal, this.#reviver);
  }

  /** Returns one page of the feed's exports, newest first. Use `allExports` to iterate every page. */
  async listExports(options?: ListExportsOptions): Promise<ExportPage> {
    const query = limitQuery(options?.limit);
    if (options?.cursor) {
      query.cursor = options.cursor;
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
   * Iterates over the feed's exports, newest first, fetching pages lazily. `options` is
   * copied when `allExports` is called; errors, including invalid parameters, are
   * thrown from the iteration.
   */
  async *allExports({ limit, cursor, signal }: ListExportsOptions = {}): AsyncGenerator<
    Export,
    void,
    undefined
  > {
    const seen = new Set([cursor ?? ""]);
    for (;;) {
      const page = await this.listExports({ limit, cursor, signal });
      signal?.throwIfAborted();
      for (const item of page.feeds) {
        yield item;
        signal?.throwIfAborted();
      }
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
    const request = {
      path: `${this.#path}/export/${exportPath(id)}`,
      policy: "transient",
    } as const;
    const [response, attempt] = await this.#transport.send(request, options?.signal);
    if (response.status >= 400) {
      throw await this.#transport.error(response, attempt);
    }
    await drain(response, attempt);
    if (response.status < 300) {
      throw new SynthientError(`expected a redirect to the export, got status ${response.status}`);
    }
    return redirectTarget(new URL(this.#transport.url(request)), response);
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

/** Converts an export ID to its URL path, with the hour unpadded. */
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

/** Blank lines are keepalives. A final line without a newline is still an event. */
async function* ndjson<T>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  reviver: Reviver | undefined,
): AsyncGenerator<T, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      const lines = decoder.decode(value, { stream: !done }).split("\n");
      lines[0] = pending + (lines[0] ?? "");
      pending = done ? "" : (lines.pop() ?? "");
      if (
        Buffer.byteLength(pending) > MAX_EVENT_SIZE ||
        lines.some((line) => Buffer.byteLength(line) > MAX_EVENT_SIZE)
      ) {
        throw new SynthientError(`stream event exceeds ${MAX_EVENT_SIZE} bytes`);
      }
      for (const line of lines) {
        const text = line.trim();
        if (text === "") {
          continue;
        }
        let event: unknown;
        try {
          event = JSON.parse(text, reviver);
        } catch (error) {
          throw new SynthientError("invalid stream event", { cause: error });
        }
        if (!isObject(event)) {
          throw new SynthientError("stream event is not a JSON object");
        }
        yield event as T;
        signal?.throwIfAborted();
      }
      if (done) {
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
