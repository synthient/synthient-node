import { isIP } from "node:net";
import { SynthientError } from "./errors.ts";
import type {
  AnonymizerEvent,
  HeliosADBEvent,
  HeliosDNSEvent,
  HeliosHTTPEvent,
  HeliosHTTPSEvent,
  JA4TEvent,
  ProxyEvent,
  TorrentEvent,
} from "./events.ts";
import { Feed, exactTunnelID } from "./feed.ts";
import { checkTimeout, limitQuery, resolveAPIKey } from "./options.ts";
import {
  Transport,
  isHTTP,
  kWait,
  wait,
  type Fetch,
  type RequestOptions,
  type ResponseMetadata,
  type Wait,
} from "./transport.ts";
import type { Account, DomainInfo, IPInfo } from "./types.ts";
import { VERSION } from "./version.ts";

/** The base URL of the Synthient HTTP API. */
export const DEFAULT_BASE_URL = "https://api.synthient.com/api/v4";

/** Configures a {@link Synthient} client. */
export interface ClientOptions {
  /** The API key. Defaults to the SYNTHIENT_API_KEY environment variable. */
  apiKey?: string | undefined;
  /** The API base URL, including the version path. Defaults to {@link DEFAULT_BASE_URL}. */
  baseURL?: string | undefined;
  /** How many times a failed request is retried. Defaults to 2; 0 disables retries. */
  maxRetries?: number | undefined;
  /**
   * The longest time in milliseconds to wait for response headers or for the next part
   * of a body, including streams and downloads. Defaults to 60,000. It does not limit a
   * whole call; see {@link RequestOptions.signal}.
   */
  timeout?: number | undefined;
  /**
   * The fetch implementation. Defaults to the global `fetch`. A custom fetch must honor
   * `init.signal` and must not follow redirects or replay requests itself; the client
   * handles each redirect to keep the API key away from other hosts.
   */
  fetch?: Fetch | undefined;
  /** Appended to the User-Agent header, such as "my-app/1.2". */
  userAgent?: string | undefined;
  /**
   * Called synchronously when each API response's headers arrive, including retries,
   * pages, stream handshakes, and responses that fail to decode. Storage download
   * responses are excluded. It must not be async. If it throws, the error is reported
   * with `process.emitWarning` and the call continues.
   */
  onResponse?: ((metadata: ResponseMetadata) => void) | undefined;
}

/** Options for {@link Synthient.lookupDomain}. */
export interface LookupDomainOptions extends RequestOptions {
  /** Caps the number of recent events returned. The API default is 50, and it clamps values above 1000. */
  limit?: number | undefined;
}

/**
 * A Synthient API client. Creating one does no network I/O. Reuse one client for every
 * request.
 *
 * Account and feed requests to the API are retried on 500, 502, 503, and 504 responses,
 * on rate limits, and on timeouts and connection failures. Lookups and health are
 * retried only on rate limits, which the API returns before doing any work. A
 * download's request to the storage host is not retried. A rate limit is a 429 with
 * Retry-After; a 429 without it means the key's monthly budget or concurrent stream
 * limit is spent, and is not retried. Retries back off exponentially with jitter and
 * honor Retry-After.
 */
export class Synthient {
  /** The residential, mobile, and datacenter proxy feed. Streaming needs the PROXY_FIREHOSE scope and exports need PROXY_FEEDS. */
  readonly proxies: Feed<ProxyEvent>;
  /** The VPN and anonymizer IP range feed. Streaming needs the ANONYMIZERS_STREAM scope and exports need ANONYMIZERS_FEED. */
  readonly anonymizers: Feed<AnonymizerEvent>;
  /** The BitTorrent DHT and tracker feed. Streaming needs the TORRENTS_STREAM scope and exports need TORRENTS_FEED. */
  readonly torrents: Feed<TorrentEvent>;
  /** The JA4T TCP fingerprint feed. Streaming needs the JA4T_STREAM scope and exports need JA4T_FEED. */
  readonly ja4t: Feed<JA4TEvent>;
  /** The Helios honeypot HTTP capture feed. Streaming needs the HONEYPOT_HTTP_STREAM scope and exports need HONEYPOT_HTTP_FEED. */
  readonly heliosHTTP: Feed<HeliosHTTPEvent>;
  /** The Helios honeypot TLS ClientHello capture feed. Streaming needs the HONEYPOT_HTTPS_STREAM scope and exports need HONEYPOT_HTTPS_FEED. */
  readonly heliosHTTPS: Feed<HeliosHTTPSEvent>;
  /** The Helios honeypot DNS tunnel feed. Streaming needs the HONEYPOT_DNS_STREAM scope and exports need HONEYPOT_DNS_FEED. */
  readonly heliosDNS: Feed<HeliosDNSEvent>;
  /** The Helios honeypot Android Debug Bridge command feed. Streaming needs the HONEYPOT_ADB_STREAM scope and exports need HONEYPOT_ADB_FEED. */
  readonly heliosADB: Feed<HeliosADBEvent>;
  readonly #transport: Transport;

  /** Throws a TypeError or RangeError if the API key is missing or an option is invalid. */
  constructor(options: ClientOptions = {}) {
    const apiKey = resolveAPIKey(options.apiKey);
    if (apiKey === "") {
      throw new TypeError("missing API key: pass apiKey or set SYNTHIENT_API_KEY");
    }
    const baseURL = URL.parse(options.baseURL ?? DEFAULT_BASE_URL);
    if (
      !isHTTP(baseURL) ||
      baseURL.search ||
      baseURL.hash ||
      baseURL.username ||
      baseURL.password
    ) {
      throw new TypeError(
        "invalid baseURL: use an http(s) URL without credentials, query, or fragment",
      );
    }
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }
    const timeout = options.timeout ?? 60_000;
    checkTimeout(timeout);

    this.#transport = new Transport({
      apiKey,
      baseURL,
      maxRetries,
      timeout,
      fetch: options.fetch ?? fetch,
      userAgent: options.userAgent
        ? `synthient-node/${VERSION} ${options.userAgent}`
        : `synthient-node/${VERSION}`,
      onResponse: options.onResponse,
      wait: (options as { [kWait]?: Wait })[kWait] ?? wait,
    });
    this.proxies = new Feed(this.#transport, "/feeds/proxies");
    this.anonymizers = new Feed(this.#transport, "/feeds/anonymizers");
    this.torrents = new Feed(this.#transport, "/feeds/torrents");
    this.ja4t = new Feed(this.#transport, "/feeds/ja4t");
    this.heliosHTTP = new Feed(this.#transport, "/feeds/helio/http", exactTunnelID);
    this.heliosHTTPS = new Feed(this.#transport, "/feeds/helio/https", exactTunnelID);
    this.heliosDNS = new Feed(this.#transport, "/feeds/helio/dns", exactTunnelID);
    this.heliosADB = new Feed(this.#transport, "/feeds/helio/adb");
  }

  /**
   * Returns intelligence for an IPv4 or IPv6 address. Each lookup costs one credit;
   * failed lookups are not billed. A private or reserved address rejects with an
   * APIError with status 422.
   */
  async lookupIP(ip: string, options?: RequestOptions): Promise<IPInfo> {
    if (typeof ip !== "string" || isIP(ip) === 0) {
      throw new TypeError("invalid IP address");
    }
    return this.#transport.json<IPInfo>(
      { path: `/lookup/ip/${pathSegment(ip)}`, policy: "rateLimit" },
      options?.signal,
    );
  }

  /**
   * Looks up as many as 1000 addresses in one request, billed as ceil(n × 0.9) credits
   * for the n distinct usable addresses. Private and reserved addresses are skipped and
   * duplicates collapse, so match results by their canonical `ip`, not by position.
   * Results follow the order each address first appears. A batch with no usable address
   * rejects with an APIError with status 422. An empty list returns [] without a request.
   */
  async lookupIPs(ips: Iterable<string>, options?: RequestOptions): Promise<IPInfo[]> {
    const addresses = Array.from(ips);
    for (const [index, ip] of addresses.entries()) {
      if (typeof ip !== "string" || isIP(ip) === 0) {
        throw new TypeError(`invalid IP address at index ${index}`);
      }
    }
    if (addresses.length === 0) {
      options?.signal?.throwIfAborted();
      return [];
    }

    const batch = await this.#transport.json<{ results: IPInfo[] }>(
      {
        method: "POST",
        path: "/lookup/ips",
        body: JSON.stringify({ ips: addresses }),
        policy: "rateLimit",
      },
      options?.signal,
    );
    if (!Array.isArray(batch.results)) {
      throw new SynthientError("batch response has no results array");
    }
    return batch.results;
  }

  /**
   * Returns the honeypot traffic observed for a domain. A domain that was never observed
   * resolves with status "inactive" and zeroed stats. Internationalized names must be
   * sent in Punycode. Each lookup costs one credit.
   */
  async lookupDomain(domain: string, options?: LookupDomainOptions): Promise<DomainInfo> {
    if (
      typeof domain !== "string" ||
      domain === "" ||
      domain === "." ||
      domain === ".." ||
      !domain.isWellFormed()
    ) {
      throw new TypeError("invalid domain");
    }
    return this.#transport.json<DomainInfo>(
      {
        path: `/lookup/domain/${pathSegment(domain)}`,
        query: limitQuery(options?.limit),
        policy: "rateLimit",
      },
      options?.signal,
    );
  }

  /**
   * Returns the account that owns the API key, including its scopes and remaining
   * lookup credits. It costs no credits.
   */
  async account(options?: RequestOptions): Promise<Account> {
    return this.#transport.json<Account>(
      { path: "/account/me", policy: "transient" },
      options?.signal,
    );
  }

  /**
   * Resolves if the API and its dependencies are healthy. An unhealthy API rejects at
   * once with an APIError with status 503.
   */
  async health(options?: RequestOptions): Promise<void> {
    await this.#transport.json({ path: "/health", policy: "rateLimit" }, options?.signal);
  }
}

// Escapes a path segment like Go's url.PathEscape, which the other Synthient SDKs use:
// "/", "?", "#", and "%" are escaped and IPv6 colons are kept.
function pathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":");
}
