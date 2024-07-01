import axios, { AxiosInstance, AxiosProxyConfig } from 'axios';
import { API_URL, DEFAULT_TIMEOUT } from './constants';
import { ErrorResponse, InternalServerError } from './exceptions';
import { LookupResponse, VisitResponse, DeleteResponse } from './models';

/**
 * Async client for interacting with the Synthient API.
 */
class Client {
  private _http: AxiosInstance;
  default_timeout: number;

  /**
   * Initializes the client with an API key, default timeout, and optional proxy.
   * 
   * @param api_key - The API key for authorization.
   * @param default_timeout - The default timeout for requests.
   * @param proxy - Optional proxy configuration.
   * @param port - Optional port for the proxy.
   */
  constructor(api_key: string, default_timeout: number = DEFAULT_TIMEOUT, proxy?: string, port?: number) {
    const proxyConfig: AxiosProxyConfig | undefined = proxy
      ? {
          host: proxy,
          port: port ? port : 8000, // Use provided port or default to 8000
        }
      : undefined;

    this._http = axios.create({
      headers: { Authorization: api_key },
      proxy: proxyConfig,
      timeout: default_timeout,
      validateStatus: () => true,
    });
    this.default_timeout = default_timeout;
  }

  /**
   * Lookup a token and return its corresponding data.
   * 
   * @param token - Token to lookup.
   * @throws ErrorResponse | InternalServerError - If the server returns a 401, 404, 409, or 500 status code.
   * @returns LookupResponse - The token data.
   */
  async lookup(token: string): Promise<LookupResponse> {
    const resp = await this._http.get(`${API_URL}lookup/${token}`);
    if (resp.status === 200) {
      return new LookupResponse(
        resp.data.token,
        resp.data.token_type,
        resp.data.session,
        resp.data.device,
        resp.data.browser,
        resp.data.ip,
        resp.data.ip_data,
        resp.data.location,
        resp.data.page,
        resp.data.risk_score,
        resp.data.is_incognito,
        resp.data.is_bot,
        resp.data.is_vm,
        resp.data.solved,
        resp.data.consumed
      );
    } else if ([401, 404, 409].includes(resp.status)) {
      throw new ErrorResponse(resp.data.message);
    } else {
      throw new InternalServerError("Server failed to lookup token.");
    }
  }

  /**
   * Lookup a session and return its corresponding visit data.
   * 
   * @param session - Session to lookup.
   * @throws ErrorResponse | InternalServerError - If the server returns a 401, 409, or 500 status code.
   * @returns VisitResponse - The session data.
   */
  async visits(session: string): Promise<VisitResponse> {
    const resp = await this._http.get(`${API_URL}visits/${session}`);
    if (resp.status === 200) {
      return new VisitResponse(resp.data.session, resp.data.visits, resp.data.has_next);
    } else if ([401, 409].includes(resp.status)) {
      throw new ErrorResponse(resp.data.message);
    } else {
      throw new InternalServerError("Server failed to lookup token.");
    }
  }

  /**
   * Delete a token.
   * 
   * @param token - Token to delete.
   * @throws InternalServerError - If the server returns a 500 status code.
   * @returns DeleteResponse - The response from the server.
   */
  async delete(token: string): Promise<DeleteResponse> {
    const resp = await this._http.delete(`${API_URL}delete/${token}`);
    if (resp.status === 500) {
      throw new InternalServerError("Server failed to delete token.");
    }
    return new DeleteResponse(resp.data.message);
  }
}

export { Client };
