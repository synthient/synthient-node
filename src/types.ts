/**
 * A Unix time as sent by the API. It is in seconds, except the `timestamp` of anonymizer
 * and Helios HTTP, HTTPS, and DNS stream events, which is in milliseconds. Convert
 * either with {@link toDate}.
 */
export type UnixTime = number;

/** New values may be added. */
export type NetworkType =
  | "MOBILE"
  | "SATELLITE"
  | "IN_FLIGHT_WIFI"
  | "RESIDENTIAL"
  | "CORPORATE"
  | "ACADEMIC"
  | "DATACENTER"
  | "GOVERNMENT"
  | (string & {});

/** New values may be added. */
export type DeviceOS =
  "Android" | "Chrome OS" | "FreeBSD" | "iOS" | "Linux" | "Mac OS X" | "Windows" | (string & {});

/** New values may be added. */
export type Scope =
  | "BASIC"
  | "PROXY_FEEDS"
  | "PROXY_FIREHOSE"
  | "ANONYMIZERS_FEED"
  | "ANONYMIZERS_STREAM"
  | "JA3_FEED"
  | "JA3_STREAM"
  | "TORRENTS_FEED"
  | "TORRENTS_STREAM"
  | "HONEYPOT_HTTP_FEED"
  | "HONEYPOT_HTTP_STREAM"
  | "HONEYPOT_HTTPS_FEED"
  | "HONEYPOT_HTTPS_STREAM"
  | "HONEYPOT_ADB_FEED"
  | "HONEYPOT_ADB_STREAM"
  | "HONEYPOT_DNS_FEED"
  | "HONEYPOT_DNS_STREAM"
  | "JA4_FEED"
  | "JA4_STREAM"
  | "JA4T_FEED"
  | "JA4T_STREAM"
  | "ADMIN_PROXIES"
  | (string & {});

/** The API always sends one of these sentences. */
export type ActivityCadence =
  | "No activity in the last 30 days."
  | "Activity is evenly distributed across the day."
  | "Activity follows a weekday business-hours pattern."
  | "Activity follows a weekend pattern."
  | "Activity is burst-driven with significant peaks.";

/** New values may be added. */
export type ParquetType =
  "string" | "int64" | "uint32" | "uint64" | "bool" | "bytes" | (string & {});

/** Converts a {@link UnixTime} to a Date, reading values of 1e12 or more as milliseconds. */
export function toDate(timestamp: UnixTime): Date {
  return new Date(timestamp >= 1e12 ? timestamp : timestamp * 1000);
}

/** `network`, `location`, and `intelligence` are absent when the API has no data for them. */
export interface IPInfo {
  ip: string;
  network?: Network;
  location?: Location;
  intelligence?: Intelligence;
}

/** The network that announces an address. */
export interface Network {
  /** The autonomous system number, or 0 if the address is not routed. */
  asn: number;
  isp: string;
  type: NetworkType;
  /** The organization the address is registered to. */
  org?: string;
  domain?: string;
  abuse_email?: string;
  abuse_phone?: string;
}

export interface Location {
  /** The ISO 3166-1 alpha-2 country code. */
  country: string;
  /** The state or region. */
  state: string;
  city: string;
  /** The IANA time zone name. */
  timezone: string;
  /** The latitude in degrees. */
  latitude: number;
  /** The longitude in degrees. */
  longitude: number;
  geo_hash: string;
}

export interface Intelligence {
  /** The risk of the address, from 0 to 100. */
  risk_score: number;
  /** The kinds of services seen on the address, such as "RESIDENTIAL_PROXY". New values may be added. */
  categories: string[];
  /** New values may be added. */
  behavior: string[];
  /**
   * The proxy, VPN, and anonymizer services seen using the address. An empty list does
   * not mean the address is clean.
   */
  providers: Provider[];
  devices: Device[];
}

/** A proxy, VPN, or anonymizer service seen using an address. */
export interface Provider {
  /** The service tag, such as "BRIGHTDATA". */
  provider: string;
  /** The service category. */
  type: string;
  last_seen: UnixTime;
}

export interface Device {
  os: DeviceOS;
  /** The operating system version. */
  version: string;
  last_seen: UnixTime;
}

/** The honeypot traffic Synthient has observed for a domain. */
export interface DomainInfo {
  domain: string;
  /**
   * "active" when the domain had events in the last 24 hours. A domain that was never
   * observed is "inactive" with zeroed stats.
   */
  status: "active" | "inactive";
  stats: DomainStats;
  unique_ips: UniqueIPs;
  /** Daily event counts. */
  time_series: TimeSeriesPoint[];
  /** The network that sent the most events, absent when there are none. */
  top_asn?: ASNCount;
  top_subdomains: SubdomainCount[];
  top_ports: PortCount[];
  /** Event counts by source country. */
  geo_distribution: CountryCount[];
  /**
   * Event counts over the last 30 days as 7 rows, Monday first, of 24 hourly columns,
   * all in UTC.
   */
  hour_dow_heatmap: number[][];
  activity_stats: ActivityStats;
  /** The most recent events, capped by the `limit` passed to `lookupDomain`. */
  recent_events: DomainEvent[];
}

export interface DomainStats {
  events_24h: number;
  total_events_30d: number;
}

/** Counts of the distinct source addresses seen for a domain. */
export interface UniqueIPs {
  value_24h: number;
  value_30d: number;
  /** Hourly counts for the last 24 hours. */
  sparkline_24h: number[];
}

/** The event counts for one day. */
export interface TimeSeriesPoint {
  /** The start of the UTC day. */
  date: UnixTime;
  events: number;
  unique_ips: number;
}

export interface ASNCount {
  asn: number;
  events: number;
}

export interface SubdomainCount {
  subdomain: string;
  count: number;
}

export interface PortCount {
  /** The targeted port. */
  port: number;
  count: number;
}

export interface CountryCount {
  /** The ISO 3166-1 alpha-2 country code. */
  country_code: string;
  events: number;
  unique_ips: number;
}

export interface ActivityStats {
  cadence: ActivityCadence;
  median_per_hour: number;
  p95_per_hour: number;
  /** The busiest UTC hour, from 0 to 23, over the last 30 days. */
  peak_hour: number;
  /** The quietest UTC hour, from 0 to 23, over the last 30 days. */
  quiet_hour: number;
}

export interface DomainEvent {
  timestamp: UnixTime;
  /** The full proxy exit address that carried the event. Despite the name, it is not masked. */
  source_ip_masked: string;
  target_subdomain: string;
  /** The source country. */
  country_code: string;
  /** The targeted port. */
  port: number;
}

export interface Account {
  email: string;
  first_name: string;
  last_name: string;
  organization: Organization;
  /** The permissions granted to the key. */
  scopes: Scope[];
  lookup_quota: LookupQuota;
  /** The API key used for the request. */
  api_key?: AccountAPIKey;
}

export interface Organization {
  id: string;
  name: string;
  /** The account's role in the organization. */
  relation: "OWNER" | "ADMIN" | "MEMBER";
}

export interface LookupQuota {
  credits: number;
  /** Seconds until the credits reset. */
  resets_in: number;
}

export interface AccountAPIKey {
  /** The key ID. It is not the secret key. */
  id: string;
  name: string;
  /** When the key was created, as an RFC 3339 string. */
  created_at: string;
}

/** One page of a feed's exports, newest first. */
export interface ExportPage {
  /** The feed's stream identifier, such as "proxies". */
  stream: string;
  /** The exports on this page. */
  feeds: Export[];
  /** Pass it as `cursor` to fetch the next page. It is absent, null, or "" on the last page. */
  next_cursor?: string | null;
}

/** A parquet export of a feed. */
export interface Export {
  /**
   * Identifies the export: "YYYY-MM-DD" for a daily export, "YYYY-MM-DD/H" with an
   * unpadded hour for an hourly one, or "latest" for the newest hourly export on the
   * first page. Pass it to `download`.
   */
  id: string;
  /** Whether the export covers a UTC day or a UTC hour. */
  kind: "hourly" | "daily";
  /** The UTC day of the export as "YYYY-MM-DD". */
  date: string;
  /** The UTC hour of an hourly export, absent or null for a daily export. */
  hour?: number | null;
  size_bytes: number;
  row_count: number;
  /** The hex-encoded SHA-256 of the parquet file. */
  checksum: string;
  created_at: UnixTime;
  /** The API path of the export's download, including the version prefix. */
  download_path: string;
}

export interface ExportMeta {
  id: string;
  stream: string;
  /** Whether the export covers a UTC day or a UTC hour. */
  kind: "hourly" | "daily";
  format: "parquet";
  /** The start of the export: midnight UTC for a daily export, the hour for an hourly one. */
  date: UnixTime;
  /** The UTC hour of an hourly export, absent or null for a daily export. */
  hour?: number | null;
  rows: number;
  /** The size of the parquet file in bytes. */
  size: number;
  /** The hex-encoded SHA-256 of the parquet file. */
  checksum: string;
  created_at: UnixTime;
  schema: ParquetSchema;
}

export interface ParquetSchema {
  /** The columns in file order. */
  fields: ParquetColumn[];
}

export interface ParquetColumn {
  name: string;
  type: ParquetType;
}
