import { once } from "node:events";
import http from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import type { TestContext } from "node:test";
import { Synthient, type ClientOptions, type Fetch } from "../src/index.ts";
import { kWait, type Wait } from "../src/transport.ts";

export const API_KEY = "test-key";
export const BASE_URL = "https://api.test/api/v4";

export const IP_INFO = {
  ip: "8.8.8.8",
  network: {
    asn: 15169,
    isp: "Google LLC",
    org: "Google",
    domain: "google.com",
    type: "DATACENTER",
    abuse_email: "network-abuse@google.com",
  },
  location: {
    country: "US",
    state: "California",
    city: "Mountain View",
    timezone: "America/Los_Angeles",
    latitude: 37.4056,
    longitude: -122.0775,
    geo_hash: "9q9hvu",
  },
  intelligence: {
    risk_score: 12,
    categories: ["DATACENTER"],
    behavior: [],
    providers: [{ provider: "BRIGHTDATA", type: "RESIDENTIAL_PROXY", last_seen: 1778187600 }],
    devices: [{ os: "ANDROID", version: "14", last_seen: 1778187600 }],
  },
};

export const EXPORT = {
  id: "2026-05-07/21",
  kind: "hourly",
  date: "2026-05-07",
  hour: 21,
  size_bytes: 1048576,
  row_count: 1200,
  checksum: "ab12",
  created_at: 1778187600,
  download_path: "/api/v4/feeds/proxies/export/2026-05-07/21",
};

export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/**
 * Returns a fetch that records each request and answers with `handler`. Responses get
 * the request URL, as they do from a real fetch.
 */
export function stub(handler: (request: Recorded, index: number) => Response | Promise<Response>): {
  fetch: Fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetch: Fetch = async (input, init) => {
    init.signal?.throwIfAborted();
    const request = {
      method: init.method ?? "GET",
      url: input,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };
    requests.push(request);
    const response = await handler(request, requests.length - 1);
    Object.defineProperty(response, "url", { value: input });
    return response;
  };
  return { fetch, requests };
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function problem(
  status: number,
  fields: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { status, ...fields },
    { "content-type": "application/problem+json", ...headers },
  );
}

export function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location } });
}

/** A 429 from the rate limiter, which always carries Retry-After. */
export function rateLimited(retryAfter = "0"): Response {
  return problem(429, {}, { "retry-after": retryAfter });
}

/** A response whose body is sent as exactly these chunks. */
export function chunked(chunks: (string | Uint8Array)[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

/** Creates a client that never sleeps between retries unless given a `wait`. */
export function newClient(
  options: ClientOptions = {},
  wait: Wait = () => Promise.resolve(),
): Synthient {
  const withWait = { apiKey: API_KEY, baseURL: BASE_URL, ...options, [kWait]: wait };
  return new Synthient(withWait);
}

/** Returns a wait that records each backoff delay instead of sleeping. */
export function recordWaits(): [number[], Wait] {
  const waits: number[] = [];
  return [
    waits,
    (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  ];
}

export interface ServerRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  remotePort: number | undefined;
}

export interface Server {
  origin: string;
  baseURL: string;
  requests: ServerRequest[];
}

/** Starts listening on a loopback port and returns the port. */
export async function listen(server: NetServer): Promise<number> {
  await once(server.listen(0, "127.0.0.1"), "listening");
  return (server.address() as AddressInfo).port;
}

/** Starts a loopback HTTP server that is closed when the test ends. */
export async function serve(
  t: TestContext,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Server> {
  const requests: ServerRequest[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        remotePort: req.socket.remotePort,
      });
      handler(req, res);
    });
  });
  const port = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${port}`;
  return { origin, baseURL: `${origin}/api/v4`, requests };
}

/**
 * Starts a server that writes `chunk` every few milliseconds until the client
 * disconnects, and returns it with a promise that resolves on that disconnect.
 */
export async function trickle(
  t: TestContext,
  chunk: string,
): Promise<{ server: Server; closed: Promise<undefined> }> {
  const { promise: closed, resolve } = Promise.withResolvers<undefined>();
  const server = await serve(t, (_, res) => {
    const timer = setInterval(() => {
      res.write(chunk);
    }, 5);
    res.on("close", () => {
      clearInterval(timer);
      resolve(undefined);
    });
  });
  return { server, closed };
}

/** Starts a server that redirects every request to `location`. */
export function redirectTo(t: TestContext, location: string): Promise<Server> {
  return serve(t, (_, res) => {
    res.writeHead(307, { location });
    res.end();
  });
}

/** Sets SYNTHIENT_API_KEY for the rest of the test, or unsets it for undefined. */
export function setAPIKeyEnv(t: TestContext, value: string | undefined): void {
  const set = (next: string | undefined) => {
    if (next === undefined) {
      delete process.env.SYNTHIENT_API_KEY;
    } else {
      process.env.SYNTHIENT_API_KEY = next;
    }
  };
  const saved = process.env.SYNTHIENT_API_KEY;
  t.after(() => {
    set(saved);
  });
  set(value);
}

/** Returns a loopback port that nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
