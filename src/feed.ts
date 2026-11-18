import { SynthientError, isObject } from "./errors.ts";
import { limitQuery } from "./options.ts";
import { drain, redirectTarget, type RequestOptions, type Transport } from "./transport.ts";
import type {
  Export,
  ExportFormat,
  ExportMeta,
  ExportPage,
  ExportVariant,
  ExportVolume,
} from "./types.ts";

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
  /** Lists only the exports of this UTC day, as "YYYY-MM-DD" like {@link dailyExport} returns. */
  day?: string | undefined;
  /**
   * Lists the lite files instead, which only the proxies, anonymizers, and JA4T feeds
   * have; on other feeds the lite listing is empty. A lite export has the same `id` as
   * the full one, so pass the variant again to download it.
   */
  variant?: ExportVariant | undefined;
}

export interface ExportOptions extends RequestOptions {
  /**
   * Uses the export's lite file, which only the proxies, anonymizers, and JA4T feeds
   * have. A lite file is published shortly after its export. Until then, and on other
   * feeds, a lite export rejects with an APIError with status 404.
   */
  variant?: ExportVariant | undefined;
}

export interface ExportVolumeOptions extends RequestOptions {
  /** The number of UTC days to cover, including today. The API default is 90, and it accepts 1 to 366. */
  days?: number | undefined;
}

export type ListDatasetExportsOptions = Omit<ListExportsOptions, "variant">;

export interface DatasetExportOptions extends RequestOptions {
  /**
   * The file to use. Geolocation has "parquet", the default, "csv", which is
   * gzip-compressed with a header row, and "mmdb", a MaxMind DB. WHOIS has only
   * "tar.gz". A format the day doesn't have rejects with an APIError with status 404.
   */
  format?: ExportFormat | undefined;
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
  readonly #exports: Exports;

  /** @internal Feeds are created by the client. */
  constructor(transport: Transport, path: string, reviver?: Reviver) {
    this.#transport = transport;
    this.#path = path;
    this.#reviver = reviver;
    this.#exports = new Exports(transport, path, true);
  }

  /**
   * Streams the feed's real-time events. The connection opens on the first `next()`,
   * which throws any connection error, such as an APIError with status 403 for a
   * missing scope. The server can close a stream at any time, such as during a deploy,
   * which ends the iteration normally; any other failure throws. Breaking out of the
   * loop closes the connection. Events sent between connections are missed, so call
   * `stream` again to reconnect. The client's `timeout` bounds the gap between data,
   * and the server sends a keepalive about every 15 seconds.
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
  listExports(options?: ListExportsOptions): Promise<ExportPage> {
    return this.#exports.list(options);
  }

  /**
   * Iterates over the feed's exports, newest first, fetching pages lazily. `options` is
   * copied when `allExports` is called; errors, including invalid parameters, are
   * thrown from the iteration.
   */
  allExports(options?: ListExportsOptions): AsyncGenerator<Export, void, undefined> {
    return this.#exports.all(options);
  }

  /** Returns the rows and bytes the feed exported per UTC day, oldest first. */
  exportVolume(options?: ExportVolumeOptions): Promise<ExportVolume> {
    return this.#exports.volume(options);
  }

  /** Returns the checksum, size, row count, and parquet schema of an export. */
  exportMeta(id: string, options?: ExportOptions): Promise<ExportMeta> {
    return this.#exports.meta(id, options);
  }

  /**
   * Returns a presigned URL for an export's parquet file, for tools that read parquet
   * over HTTPS directly. The URL is valid for 24 hours and grants access without an API
   * key, so treat it as a secret.
   */
  downloadURL(id: string, options?: ExportOptions): Promise<URL> {
    return this.#exports.downloadURL(id, options);
  }

  /**
   * Downloads an export's parquet file as a byte stream. Read it to the end or cancel it
   * to release the connection. The API key is sent only to the Synthient API, never to
   * the storage host that serves the file, and errors never include the presigned URL.
   * A non-success response from either returns an APIError.
   */
  download(id: string, options?: ExportOptions): Promise<ReadableStream<Uint8Array>> {
    return this.#exports.download(id, options);
  }
}

/**
 * A Synthient dataset, published as one export per UTC day with no stream and no hourly
 * exports. Access datasets through the client, such as `client.geolocation`.
 *
 * Export IDs are "latest" for the newest day or a UTC day as "YYYY-MM-DD". `Export.id`
 * values and the results of {@link dailyExport} can be passed as they are.
 */
export class Dataset {
  readonly #exports: Exports;

  /** @internal Datasets are created by the client. */
  constructor(transport: Transport, path: string) {
    this.#exports = new Exports(transport, path, false);
  }

  /** Returns one page of the dataset's exports, newest first. Use `allExports` to iterate every page. */
  listExports(options?: ListDatasetExportsOptions): Promise<ExportPage> {
    return this.#exports.list(options);
  }

  /**
   * Iterates over the dataset's exports, newest first, fetching pages lazily. `options`
   * is copied when `allExports` is called; errors, including invalid parameters, are
   * thrown from the iteration.
   */
  allExports(options?: ListDatasetExportsOptions): AsyncGenerator<Export, void, undefined> {
    return this.#exports.all(options);
  }

  /** Returns the rows and bytes the dataset exported per UTC day, oldest first. */
  exportVolume(options?: ExportVolumeOptions): Promise<ExportVolume> {
    return this.#exports.volume(options);
  }

  /**
   * Returns the checksum, size, row count, and schema of an export's file in the
   * requested format, and lists every file of the day.
   */
  exportMeta(id: string, options?: DatasetExportOptions): Promise<ExportMeta> {
    return this.#exports.meta(id, options);
  }

  /**
   * Returns a presigned URL for an export's file. The URL is valid for 24 hours and
   * grants access without an API key, so treat it as a secret.
   */
  downloadURL(id: string, options?: DatasetExportOptions): Promise<URL> {
    return this.#exports.downloadURL(id, options);
  }

  /**
   * Downloads an export's file as a byte stream, exactly as served: a "csv" file stays
   * gzip-compressed and a WHOIS archive stays packed. Read it to the end or cancel it to
   * release the connection. The API key is sent only to the Synthient API, never to the
   * storage host that serves the file, and errors never include the presigned URL. A
   * non-success response from either returns an APIError.
   */
  download(id: string, options?: DatasetExportOptions): Promise<ReadableStream<Uint8Array>> {
    return this.#exports.download(id, options);
  }
}

type FileOptions = ExportOptions & DatasetExportOptions;

/** The export routes that feeds and datasets share under their path. */
class Exports {
  readonly #transport: Transport;
  readonly #path: string;
  readonly #hourly: boolean;

  constructor(transport: Transport, path: string, hourly: boolean) {
    this.#transport = transport;
    this.#path = path;
    this.#hourly = hourly;
  }

  async list(options: ListExportsOptions = {}): Promise<ExportPage> {
    const query = limitQuery(options.limit);
    if (options.cursor) {
      query.cursor = options.cursor;
    }
    if (options.day !== undefined) {
      query.day = options.day;
    }
    if (options.variant !== undefined) {
      query.variant = options.variant;
    }

    const page = await this.#transport.json<ExportPage>(
      { path: `${this.#path}/export`, query, policy: "transient" },
      options.signal,
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

  async *all({ cursor, ...options }: ListExportsOptions = {}): AsyncGenerator<
    Export,
    void,
    undefined
  > {
    const seen = new Set([cursor ?? ""]);
    for (;;) {
      const page = await this.list({ ...options, cursor });
      options.signal?.throwIfAborted();
      for (const item of page.feeds) {
        yield item;
        options.signal?.throwIfAborted();
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

  async volume(options: ExportVolumeOptions = {}): Promise<ExportVolume> {
    const query: Record<string, string> = {};
    if (options.days !== undefined) {
      query.days = String(options.days);
    }
    return this.#transport.json<ExportVolume>(
      { path: `${this.#path}/export/daily`, query, policy: "transient" },
      options.signal,
    );
  }

  async meta(id: string, options: FileOptions = {}): Promise<ExportMeta> {
    const meta = await this.#transport.json<ExportMeta>(
      {
        path: `${this.#path}/export/${this.#exportPath(id)}/meta`,
        query: fileQuery(options),
        policy: "transient",
      },
      options.signal,
    );
    // The WHOIS meta once sent `"fields": null` for its archive's empty schema.
    for (const { schema } of [meta, ...(meta.entities ?? [])]) {
      if (schema) {
        schema.fields = Array.isArray(schema.fields) ? schema.fields : [];
      }
    }
    return meta;
  }

  async downloadURL(id: string, options: FileOptions = {}): Promise<URL> {
    const request = {
      path: `${this.#path}/export/${this.#exportPath(id)}`,
      query: fileQuery(options),
      policy: "transient",
    } as const;
    const [response, attempt] = await this.#transport.send(request, options.signal);
    if (response.status >= 400) {
      throw await this.#transport.error(response, attempt);
    }
    await drain(response, attempt);
    if (response.status < 300 || response.status === 304) {
      throw new SynthientError(`expected a redirect to the export, got status ${response.status}`);
    }
    return redirectTarget(new URL(this.#transport.url(request)), response);
  }

  async download(id: string, options: FileOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const url = await this.downloadURL(id, options);
    return this.#transport.download(url, options.signal);
  }

  /** Converts an export ID to its URL path, with the hour unpadded. */
  #exportPath(id: string): string {
    if (id === "latest") {
      return id;
    }
    const match = EXPORT_ID.exec(id);
    if (match && (this.#hourly || match[4] === undefined)) {
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
}

function fileQuery({ variant, format }: FileOptions): Record<string, string> {
  const query: Record<string, string> = {};
  if (variant !== undefined) {
    query.variant = variant;
  }
  if (format !== undefined) {
    query.format = format;
  }
  return query;
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
