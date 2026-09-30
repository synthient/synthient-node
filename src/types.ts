/**
 * A Unix time as sent by the API. It is in seconds, except the `timestamp` of anonymizer
 * and Helios HTTP, HTTPS, and DNS stream events, which is in milliseconds. Convert
 * either with {@link toDate}.
 */
export type UnixTime = number;

/** A network type. New values may be added. */
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

/** An operating system seen behind an address. New values may be added. */
export type DeviceOS =
  "Android" | "Chrome OS" | "FreeBSD" | "iOS" | "Linux" | "Mac OS X" | "Windows" | (string & {});

/** A permission granted to an API key. New values may be added. */
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

/** The activity pattern of a domain, always one of these sentences. */
export type ActivityCadence =
  | "No activity in the last 30 days."
  | "Activity is evenly distributed across the day."
  | "Activity follows a weekday business-hours pattern."
  | "Activity follows a weekend pattern."
  | "Activity is burst-driven with significant peaks.";

/** A parquet column type. New values may be added. */
export type ParquetType =
  "string" | "int64" | "uint32" | "uint64" | "bool" | "bytes" | (string & {});

/**
 * Converts a {@link UnixTime} to a Date. Values of 1e12 or more are read as
 * milliseconds, since as seconds they would be tens of thousands of years away.
 */
export function toDate(timestamp: UnixTime): Date {
  return new Date(timestamp >= 1e12 ? timestamp : timestamp * 1000);
}

/**
 * The intelligence Synthient holds for an IP address. `network`, `location`, and
 * `intelligence` are absent when the API has no data for them.
 */
export interface IPInfo {
  /** The address that was looked up. */
  ip: string;
  /** The network that announces the address. */
  network?: Network;
  /** The address's geolocation. */
  location?: Location;
  /** The risk score and the proxy, VPN, and device observations for the address. */
  intelligence?: Intelligence;
}

/** The network that announces an address. */
export interface Network {
  /** The autonomous system number, or 0 if the address is not routed. */
  asn: number;
  /** The name of the internet service provider. */
  isp: string;
  /** The network type. */
  type: NetworkType;
  /** The organization the address is registered to. */
  org?: string;
  /** The network operator's domain. */
  domain?: string;
  /** The operator's abuse contact email. */
  abuse_email?: string;
  /** The operator's abuse contact phone number. */
  abuse_phone?: string;
}

/** The geolocation of an address. */
export interface Location {
  /** The ISO 3166-1 alpha-2 country code. */
  country: string;
  /** The state or region. */
  state: string;
  /** The city. */
  city: string;
  /** The IANA time zone name. */
  timezone: string;
  /** The latitude in degrees. */
  latitude: number;
  /** The longitude in degrees. */
  longitude: number;
  /** The geohash of the coordinates. */
  geo_hash: string;
}

/** Synthient's assessment of an address. */
export interface Intelligence {
  /** The risk of the address, from 0 to 100. */
  risk_score: number;
  /** The kinds of services seen on the address, such as "RESIDENTIAL_PROXY". New values may be added. */
  categories: string[];
  /** Behaviors observed from the address. New values may be added. */
  behavior: string[];
  /**
   * The proxy, VPN, and anonymizer services seen using the address. An empty list does
   * not mean the address is clean.
   */
  providers: Provider[];
  /** The device types seen behind the address. */
  devices: Device[];
}

/** A proxy, VPN, or anonymizer service seen using an address. */
export interface Provider {
  /** The service tag, such as "BRIGHTDATA". */
  provider: string;
  /** The service category. */
  type: string;
  /** When the service was last seen using the address. */
  last_seen: UnixTime;
}

/** A device type seen behind an address. */
export interface Device {
  /** The operating system. */
  os: DeviceOS;
  /** The operating system version. */
  version: string;
  /** When the device was last seen. */
  last_seen: UnixTime;
}

/** The honeypot traffic Synthient has observed for a domain. */
export interface DomainInfo {
  /** The domain that was looked up. */
  domain: string;
  /**
   * "active" when the domain had events in the last 24 hours. A domain that was never
   * observed is "inactive" with zeroed stats.
   */
  status: "active" | "inactive";
  /** Aggregate event counts. */
  stats: DomainStats;
  /** The distinct source addresses. */
  unique_ips: UniqueIPs;
  /** Daily event counts. */
  time_series: TimeSeriesPoint[];
  /** The network that sent the most events, absent when there are none. */
  top_asn?: ASNCount;
  /** The most targeted subdomains. */
  top_subdomains: SubdomainCount[];
  /** The most targeted ports. */
  top_ports: PortCount[];
  /** Event counts by source country. */
  geo_distribution: CountryCount[];
  /**
   * Event counts over the last 30 days as 7 rows, Monday first, of 24 hourly columns,
   * all in UTC.
   */
  hour_dow_heatmap: number[][];
  /** The hourly activity pattern. */
  activity_stats: ActivityStats;
  /** The most recent events, capped by the `limit` passed to `lookupDomain`. */
  recent_events: DomainEvent[];
}

/** Aggregate event counts for a domain. */
export interface DomainStats {
  /** The number of events in the last 24 hours. */
  events_24h: number;
  /** The number of events in the last 30 days. */
  total_events_30d: number;
}

/** The distinct source addresses seen for a domain. */
export interface UniqueIPs {
  /** The count for the last 24 hours. */
  value_24h: number;
  /** The count for the last 30 days. */
  value_30d: number;
  /** Hourly counts for the last 24 hours. */
  sparkline_24h: number[];
}

/** The event counts for one day. */
export interface TimeSeriesPoint {
  /** The start of the day. */
  date: UnixTime;
  /** The number of events that day. */
  events: number;
  /** The number of distinct source addresses that day. */
  unique_ips: number;
}

/** An autonomous system and its event count. */
export interface ASNCount {
  /** The autonomous system number. */
  asn: number;
  /** The number of events from the network. */
  events: number;
}

/** A subdomain and its event count. */
export interface SubdomainCount {
  /** The targeted subdomain. */
  subdomain: string;
  /** The number of events that targeted it. */
  count: number;
}

/** A port and its event count. */
export interface PortCount {
  /** The targeted port. */
  port: number;
  /** The number of events that targeted it. */
  count: number;
}

/** A source country and its counts. */
export interface CountryCount {
  /** The ISO 3166-1 alpha-2 country code. */
  country_code: string;
  /** The number of events from the country. */
  events: number;
  /** The number of distinct addresses from the country. */
  unique_ips: number;
}

/** The hourly activity pattern of a domain. */
export interface ActivityStats {
  /** How events are distributed over time. */
  cadence: ActivityCadence;
  /** The median number of events per hour. */
  median_per_hour: number;
  /** The 95th percentile of events per hour. */
  p95_per_hour: number;
  /** The busiest UTC hour of the day. */
  peak_hour: number;
  /** The quietest UTC hour of the day. */
  quiet_hour: number;
}

/** A single honeypot event for a domain. */
export interface DomainEvent {
  /** When the event happened. */
  timestamp: UnixTime;
  /** The full proxy exit address that carried the event. Despite the name, it is not masked. */
  source_ip_masked: string;
  /** The subdomain that was targeted. */
  target_subdomain: string;
  /** The source country. */
  country_code: string;
  /** The targeted port. */
  port: number;
}

/** The account that owns an API key. */
export interface Account {
  /** The account email address. */
  email: string;
  /** The account holder's first name. */
  first_name: string;
  /** The account holder's last name. */
  last_name: string;
  /** The organization the account belongs to. */
  organization: Organization;
  /** The permissions granted to the key. */
  scopes: Scope[];
  /** The remaining lookup credits. */
  lookup_quota: LookupQuota;
  /** The API key used for the request. */
  api_key?: AccountAPIKey;
}

/** The organization an account belongs to. */
export interface Organization {
  /** The organization ID. */
  id: string;
  /** The organization name. */
  name: string;
  /** The account's role in the organization. */
  relation: "OWNER" | "ADMIN" | "MEMBER";
}

/** The lookup credits available to an account. */
export interface LookupQuota {
  /** The number of lookup credits remaining. */
  credits: number;
  /** Seconds until the credits reset. */
  resets_in: number;
}

/** The API key a request was made with. */
export interface AccountAPIKey {
  /** The key ID. It is not the secret key. */
  id: string;
  /** The key name. */
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
  /** Fetches the next page. It is absent, null, or "" on the last page. */
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
  /** The size of the parquet file in bytes. */
  size_bytes: number;
  /** The number of rows in the parquet file. */
  row_count: number;
  /** The hex-encoded SHA-256 of the parquet file. */
  checksum: string;
  /** When the export was produced. */
  created_at: UnixTime;
  /** The API path of the export's download, including the version prefix. */
  download_path: string;
}

/** A parquet export's metadata, without its contents. */
export interface ExportMeta {
  /** Identifies the export. */
  id: string;
  /** The feed's stream identifier. */
  stream: string;
  /** Whether the export covers a UTC day or a UTC hour. */
  kind: "hourly" | "daily";
  /** The file format. */
  format: "parquet";
  /** The start of the export: midnight UTC for a daily export, the hour for an hourly one. */
  date: UnixTime;
  /** The UTC hour of an hourly export, absent or null for a daily export. */
  hour?: number | null;
  /** The number of rows in the parquet file. */
  rows: number;
  /** The size of the parquet file in bytes. */
  size: number;
  /** The hex-encoded SHA-256 of the parquet file. */
  checksum: string;
  /** When the export was produced. */
  created_at: UnixTime;
  /** The parquet columns. */
  schema: ParquetSchema;
}

/** The columns of a parquet export. */
export interface ParquetSchema {
  /** The columns in file order. */
  fields: ParquetColumn[];
}

/** A column of a parquet export. */
export interface ParquetColumn {
  /** The column name. */
  name: string;
  /** The column type. */
  type: ParquetType;
}
