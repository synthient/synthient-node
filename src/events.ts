import type { UnixTime } from "./types.ts";

/** The category of a proxy, VPN, or other service seen on an address. New values may be added. */
export type ServiceCategory =
  | "FREE_VPN"
  | "COMMERCIAL_VPN"
  | "ENTERPRISE_VPN"
  | "MOBILE_PROXY"
  | "BLOCKCHAIN_PROXY"
  | "RESIDENTIAL_PROXY"
  | "PUBLIC_PROXY"
  | "DATACENTER_PROXY"
  | "TOR_NODE"
  | "PRIVATE_RELAY"
  | "BOTNET"
  | "SEARCH_ENGINE"
  | "AI_CRAWLER"
  | "SOCIAL_MEDIA"
  | "UPTIME_MONITOR"
  | "LINK_PREVIEW"
  | "SEO_CRAWLER"
  | "WEB_ARCHIVER"
  | "WEBHOOK_PROVIDER"
  | "PAYMENT_PROCESSOR"
  | "INTERNET_SCANNER"
  | (string & {});

/** A proxy sighting from the proxies feed. */
export interface ProxyEvent {
  /** The proxy exit address. */
  ip?: string;
  /** The proxy service tag. */
  provider?: string;
  type?: ServiceCategory;
  /** The ISO 3166-1 alpha-2 country of the address. */
  country_code?: string;
  asn?: number;
  timestamp?: UnixTime;
}

/** A VPN or anonymizer IP range from the anonymizers feed. */
export interface AnonymizerEvent {
  /** The first address of the range. */
  range_start?: string;
  /** The last address of the range. */
  range_end?: string;
  /** The service tag. */
  provider?: string;
  type?: ServiceCategory;
  /** The ISO 3166-1 alpha-2 country of `range_start`. */
  country_code?: string;
  /** The autonomous system number of `range_start`. */
  asn?: number;
  /** When the range was seen, in Unix milliseconds. */
  timestamp?: UnixTime;
}

/** A torrent observed on the BitTorrent DHT or a tracker. */
export interface TorrentEvent {
  /** The hex-encoded SHA-1 info hash. */
  info_hash?: string;
  name?: string;
  magnet_uri?: string;
  /** The total size of the torrent's files in bytes. */
  total_size?: number;
  /** The piece size in bytes. */
  piece_length?: number;
  file_count?: number;
  files?: TorrentFile[];
  peers?: TorrentPeer[];
  timestamp?: UnixTime;
}

/** A file in a torrent. */
export interface TorrentFile {
  /** The file path within the torrent. */
  path?: string;
  /** The file size in bytes. */
  length?: number;
}

/** A peer seen sharing a torrent. */
export interface TorrentPeer {
  ip?: string;
  port?: number;
  /** Where the peer was found, such as "DHT", "PEX", or "tracker". */
  source?: string;
  /** Whether the peer supports encrypted connections. */
  encrypted?: boolean;
}

/** A JA4T TCP fingerprint sighting. */
export interface JA4TEvent {
  /** The address the fingerprint was seen from. */
  ip?: string;
  ja4t?: string;
  /** The service tag of the address. */
  provider?: string;
  type?: ServiceCategory;
  /** The ISO 3166-1 alpha-2 country of the address. */
  country_code?: string;
  asn?: number;
  timestamp?: UnixTime;
}

/** The Helios honeypot sensor that captured an event. */
export interface HeliosMeta {
  /** The proxy exit address the traffic arrived through. */
  proxy_ip?: string;
  /** The sensor that captured the traffic. */
  server?: string;
  /** The sensor pool. */
  pool_id?: string;
  /** The proxy service the traffic arrived through. */
  provider?: string;
}

/** An HTTP request captured by a Helios honeypot. */
export interface HeliosHTTPEvent {
  /** When the request was captured, in Unix milliseconds. */
  timestamp: UnixTime;
  /**
   * The proxy tunnel the request arrived through, as the exact decimal digits of an
   * unsigned 64-bit integer.
   */
  tunnel_id: string;
  /** The destination host the tunnel was opened to. */
  domain: string;
  /** The destination port. */
  port: number;
  protocol: "http";
  /** The capturing sensor. */
  meta: HeliosMeta;
  /** The parsed request. */
  details?: HTTPRequestDetails;
  /** The raw request bytes, base64-encoded. */
  raw?: string;
}

/** A parsed HTTP request. */
export interface HTTPRequestDetails {
  method?: string;
  /** The request target. */
  uri?: string;
  /** The HTTP version, such as "HTTP/1.1". */
  version?: string;
  headers?: Record<string, string>;
}

/** A TLS ClientHello captured by a Helios honeypot. */
export interface HeliosHTTPSEvent {
  /** When the handshake was captured, in Unix milliseconds. */
  timestamp: UnixTime;
  /**
   * The proxy tunnel the handshake arrived through, as the exact decimal digits of an
   * unsigned 64-bit integer.
   */
  tunnel_id: string;
  /** The destination host the tunnel was opened to. */
  domain: string;
  /** The destination port. */
  port: number;
  protocol: "https";
  /** The capturing sensor. */
  meta: HeliosMeta;
  /** The parsed ClientHello, or null when the sensor could not parse the handshake. */
  details?: TLSClientHello | null;
  /** Always null: the HTTPS sensors do not capture handshake bytes. */
  raw?: string | null;
}

/**
 * A TLS ClientHello as parsed by the Helios sensors. Fields the sensor could not parse
 * are absent, and new fields may appear.
 */
export interface TLSClientHello {
  /** The record layer version, such as "TLS 1.0". */
  record_version?: string;
  /** The handshake version, such as "TLS 1.2". */
  handshake_version?: string;
  /** The hex-encoded 32-byte client random. */
  client_random?: string;
  /** The hex-encoded session ID. */
  session_id?: string;
  /** The session ID length in bytes. */
  session_id_length?: number;
  cipher_suites?: TLSCodeName[];
  compression_methods?: number[];
  /** The extensions in wire order. */
  extensions?: TLSExtension[];
  /** The server_name extension value. */
  sni?: string;
  alpn?: string[];
  supported_versions?: string[];
  /** The supported key exchange groups. */
  supported_groups?: TLSCodeName[];
  signature_algorithms?: TLSCodeName[];
  key_share_groups?: string[];
  ec_point_formats?: string[];
  psk_key_exchange_modes?: string[];
  /** The supported certificate compression algorithms. */
  compress_certificate?: string[];
  has_grease?: boolean;
  /** Whether the application_settings extension is present. */
  application_settings?: boolean;
  /** Whether the delegated_credentials extension is present. */
  delegated_credentials?: boolean;
  /** Whether the encrypt_then_mac extension is present. */
  encrypt_then_mac?: boolean;
  /** Whether the extended_master_secret extension is present. */
  extended_master_secret?: boolean;
  /** Whether the post_handshake_auth extension is present. */
  post_handshake_auth?: boolean;
  /** Whether the renegotiation_info extension is present. */
  renegotiation_info?: boolean;
  /** Whether the signed_certificate_timestamp extension is present. */
  signed_certificate_timestamps?: boolean;
  /** Whether the status_request extension is present. */
  status_request?: boolean;
}

/** A TLS registry value, such as a cipher suite or group, with its name. */
export interface TLSCodeName {
  code?: number;
  name?: string;
}

/** A TLS extension in a ClientHello. */
export interface TLSExtension {
  code?: number;
  name?: string;
  /** The extension data length in bytes. */
  length?: number;
}

/** A DNS tunnel captured by a Helios honeypot. */
export interface HeliosDNSEvent {
  /** When the tunnel was captured, in Unix milliseconds. */
  timestamp: UnixTime;
  /** The proxy tunnel, as the exact decimal digits of an unsigned 64-bit integer. */
  tunnel_id: string;
  /** The destination host the tunnel was opened to. */
  domain: string;
  /** The destination port. */
  port: number;
  protocol: "dns";
  /** The capturing sensor. */
  meta: HeliosMeta;
}

/**
 * An Android Debug Bridge shell command captured by a Helios honeypot. The sensor sends
 * no timestamp.
 */
export interface HeliosADBEvent {
  /** Identifies the ADB session, as 32 hex characters. */
  session: string;
  /** The 1-based position of the command within its session. */
  sequential_id: number;
  /** The shell command as plain text. Invalid UTF-8 bytes become U+FFFD. */
  command: string;
  /**
   * The SHA-256 the sensor assigns to the session's payload, as 64 hex characters. It is
   * not a hash of `command`; every command in a session shares it, as do sessions that
   * replay the same script.
   */
  hash: string;
}
