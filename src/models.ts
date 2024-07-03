/**
 * The three types of tokens that can be issued.
 * METRICS - Metrics token, used for gathering data.
 * SIGN - Sign token, used for verifying the challenge.
 * STRICT - Strict token, used for strict verification.
 */
export enum TokenType {
  METRICS = "metrics",
  SIGN = "sign",
  STRICT = "strict",
}

/**
 * Translates the risk level into an action to take.
 * ALLOW - Allow the visitor to continue.
 * REDIRECT - Redirect the visitor to a different page or have them perform another form of verification.
 * BLOCK - Block the visitor from accessing.
 */
export enum ActionType {
  ALLOW = 0,
  REDIRECT = 1,
  BLOCK = 2,
}

/**
 * Risk level of the visitor. Simplified for ease of use.
 * Under certain circumstances, you may want to use the risk score.
 */
export enum RiskLevel {
  LOW = 0,
  MEDIUM = 1,
  HIGH = 2,
}

/**
 * Base response model.
 * Represents a response containing a message.
 */
export class BaseResponse {
  message: string;

  /**
   * Constructs a new BaseResponse.
   * 
   * @param message - The response message.
   */
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Device model, contains core information relating to the visitor device.
 */
export class Device {
  model?: string;
  brand?: string;
  os: string;
  version: string;

  /**
   * Constructs a new Device.
   * 
   * @param model - The model of the device, if available.
   * @param brand - The brand of the device.
   * @param os - The operating system of the device.
   * @param version - The version of the operating system.
   */
  constructor(model: string | undefined, brand: string, os: string, version: string) {
    this.model = model;
    this.brand = brand;
    this.os = os;
    this.version = version;
  }
}

/**
 * Browser model, contains information about the browser being used.
 */
export class Browser {
  name: string;
  version: string;

  /**
   * Constructs a new Browser.
   * 
   * @param name - The name of the browser.
   * @param version - The version of the browser.
   */
  constructor(name: string, version: string) {
    this.name = name;
    this.version = version;
  }
}

/**
   * IpData model, contains information about the IP address
   */
export class IpData {
  is_vpn: boolean;
  is_proxy: boolean;
  is_tor: boolean;
  is_relay: boolean;
  asn: string;

  /**
   * Constructs a new IpData.
   * 
   * @param is_vpn - If the IP address is a VPN.
   * @param is_proxy - If the IP address is a proxy.
   * @param is_tor - If the IP address is a TOR node.
   * @param is_relay - If the IP address is a relay.
   * @param asn - The ASN of the IP address.
   */
  constructor(is_vpn: boolean, is_proxy: boolean, is_tor: boolean, is_relay: boolean, asn: string) {
    this.is_vpn = is_vpn;
    this.is_proxy = is_proxy;
    this.is_tor = is_tor;
    this.is_relay = is_relay;
    this.asn = asn;
  }
}

/**
 * Location model, contains information about the location of the IP address.
 */
export class Location {
  city: string;
  region: string;
  country: string;
  region_code: string;
  country_code: string;
  latitude: number;
  longitude: number;

  /**
   * Constructs a new Location.
   * 
   * @param city - The city of the IP address.
   * @param region - The region of the IP address.
   * @param country - The country of the IP address.
   * @param region_code - The region code of the IP address.
   * @param country_code - The country code of the IP address.
   * @param latitude - The latitude of the IP address.
   * @param longitude - The longitude of the IP address.
   */
  constructor(city: string, region: string, country: string, region_code: string, country_code: string, latitude: number, longitude: number) {
    this.city = city;
    this.region = region;
    this.country = country;
    this.region_code = region_code;
    this.country_code = country_code;
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

/**
 * Response model for the lookup endpoint.
 */
export class LookupResponse {
  token: string;
  token_type: TokenType;
  session: string;
  device?: Device;
  browser?: Browser;
  ip: string;
  ip_data?: IpData;
  location?: Location;
  page?: string;
  risk_score: number;
  is_incognito: boolean;
  is_bot: boolean;
  is_vm: boolean;
  solved?: boolean;
  consumed: boolean;

  /**
   * Constructs a new LookupResponse.
   * 
   * @param token - The token of the visitor.
   * @param token_type - The type of token that was issued (metrics, sign, strict).
   * @param session - The persistent session of the visitor, will not change.
   * @param device - The device information of the visitor.
   * @param browser - The browser information of the visitor.
   * @param ip - The IP address of the visitor.
   * @param ip_data - The IP data of the visitor.
   * @param location - The location of the visitor.
   * @param page - The page the visitor is on.
   * @param risk_score - The risk score of the visitor.
   * @param is_incognito - If the visitor is in incognito mode.
   * @param is_bot - If the visitor is a bot.
   * @param is_vm - If the visitor is using a VM.
   * @param solved - If the visitor has solved the captcha (if applicable).
   * @param consumed - If the token has been consumed (used before).
   */
  constructor(
    token: string,
    token_type: TokenType,
    session: string,
    device: Device | undefined,
    browser: Browser | undefined,
    ip: string,
    ip_data: IpData | undefined,
    location: Location | undefined,
    page: string | undefined,
    risk_score: number,
    is_incognito: boolean,
    is_bot: boolean,
    is_vm: boolean,
    solved: boolean | undefined,
    consumed: boolean
  ) {
    this.token = token;
    this.token_type = token_type;
    this.session = session;
    this.device = device;
    this.browser = browser;
    this.ip = ip;
    this.ip_data = ip_data;
    this.location = location;
    this.page = page;
    this.risk_score = risk_score;
    this.is_incognito = is_incognito;
    this.is_bot = is_bot;
    this.is_vm = is_vm;
    this.solved = solved;
    this.consumed = consumed;
  }

  /**
   * Computes the risk level based on the risk score.
   */
  get risk_level(): RiskLevel {
    if (this.risk_score < 20) return RiskLevel.LOW;
    if (this.risk_score < 50) return RiskLevel.MEDIUM;
    return RiskLevel.HIGH;
  }
}

/**
 * Response model for the visits endpoint.
 */
export class VisitResponse extends BaseResponse {
  session: string;
  visits: LookupResponse[];
  has_next: boolean;

  /**
   * Constructs a new VisitResponse.
   * 
   * @param session - The session of the visitor.
   * @param visits - The list of visit responses.
   * @param has_next - Whether there are more visits.
   */
  constructor(session: string, visits: LookupResponse[], has_next: boolean) {
    super('');
    this.session = session;
    this.visits = visits;
    this.has_next = has_next;
  }
}

/**
 * Response model for the delete endpoint.
 */
export class DeleteResponse extends BaseResponse {
  /**
   * Constructs a new DeleteResponse.
   * 
   * @param message - The response message from the server.
   */
  constructor(message: string) {
    super(message);
  }
}
