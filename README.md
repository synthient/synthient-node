<p align="center">
  <a href="https://synthient.com">
    <img src="assets/logo.svg" height="96" alt="Synthient logo">
  </a>
</p>
<h3 align="center">Synthient</h3>
<p align="center">High-fidelity data on residential proxies, VPNs, and other anonymized IPs.</p>
<p align="center">
  <a href="https://docs.synthient.com">Documentation</a> ·
  <a href="https://www.npmjs.com/package/@synthient/synthient">npm</a> ·
  <a href="https://docs.synthient.com/misc/support">Support</a>
</p>

# synthient-node

`@synthient/synthient` is the official Node.js SDK for the [Synthient API](https://docs.synthient.com): IP and domain intelligence, account details, and real-time and bulk data feeds. It is written in TypeScript and ships with type definitions.

[![npm](https://img.shields.io/npm/v/@synthient/synthient)](https://www.npmjs.com/package/@synthient/synthient)
[![test](https://github.com/synthient/synthient-node/actions/workflows/test.yml/badge.svg)](https://github.com/synthient/synthient-node/actions/workflows/test.yml)
[![lint](https://github.com/synthient/synthient-node/actions/workflows/lint.yml/badge.svg)](https://github.com/synthient/synthient-node/actions/workflows/lint.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## Table of Contents

- [synthient-node](#synthient-node)
  - [SDK Installation](#sdk-installation)
  - [Requirements](#requirements)
  - [API Keys](#api-keys)
  - [Authentication](#authentication)
  - [SDK Example Usage](#sdk-example-usage)
  - [Available Resources and Operations](#available-resources-and-operations)
  - [Streaming](#streaming)
  - [Pagination](#pagination)
  - [Downloads](#downloads)
  - [Retries](#retries)
  - [Timeouts](#timeouts)
  - [Error Handling](#error-handling)
  - [Server Selection](#server-selection)
  - [Custom HTTP Client](#custom-http-client)
  - [Debugging](#debugging)
  - [gRPC Schema](#grpc-schema)
- [Development](#development)
  - [Maturity](#maturity)
  - [Contributions](#contributions)
  - [License](#license)

## SDK Installation

The SDK can be installed with [npm](https://www.npmjs.com/), [pnpm](https://pnpm.io/), [bun](https://bun.sh/), or [yarn](https://yarnpkg.com/).

### NPM

```sh
npm add @synthient/synthient
```

### PNPM

```sh
pnpm add @synthient/synthient
```

### Bun

```sh
bun add @synthient/synthient
```

### Yarn

```sh
yarn add @synthient/synthient
```

> [!NOTE]
> This package is published as an ES module only. On the supported Node.js versions, CommonJS code can also load it with `require()`.

The [gRPC schema fetcher](#grpc-schema) is the `@synthient/synthient/grpcschema` subpath of the same package. It needs two optional peer dependencies, which you install only if you use it.

## Requirements

Node.js 22.12 or later. The tests run on Node.js 22, 24, and 26; other runtimes, such as Bun and Deno, are not tested. The SDK is for server-side code: it uses Node.js built-in modules, and your API key should never reach a browser. It has no runtime dependencies, and its type definitions are tested with TypeScript 5.8 and later.

## API Keys

Every request to the HTTP API needs a Synthient API key. Keys are issued from the Synthient dashboard; if you don't have one yet, [contact us](mailto:contact@synthient.com). Each key carries scopes that decide what it can call. `BASIC` covers the lookups and `account`, and each feed has one scope for its real-time stream and one for its exports, listed under [Feeds](#feeds). See [Authentication](https://docs.synthient.com/authentication) for how scopes work.

If a request fails even though you are sending a key, it is usually one of these:

- **401 Unauthorized**: the key is malformed, unknown, or revoked. Check that it was loaded from the environment and isn't truncated.
- **402 Payment Required**: the team is out of lookup credits. `account` reports the remaining balance and when it resets.
- **403 Forbidden**: the key lacks the scope for that endpoint or feed. `account` lists the key's scopes.

## Authentication

This SDK supports the following security scheme:

| Name     | Type    | Scheme             | Environment Variable |
| -------- | ------- | ------------------ | -------------------- |
| `apiKey` | API key | `x-api-key` header | `SYNTHIENT_API_KEY`  |

By default, the client reads the key from the `SYNTHIENT_API_KEY` environment variable:

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient();
```

To use a key from somewhere else, such as a secret manager, pass it as `apiKey`:

```ts
const client = new Synthient({ apiKey: await getSecret("synthient-api-key") });
```

The constructor throws a `TypeError` if there is no key, or if the key has characters other than printable ASCII. It makes no network calls, so an invalid key shows up as a 401 on the first request. The key is sent only to the Synthient API, never to the storage host that serves export downloads.

## SDK Example Usage

### Look up an IP address

Get the network, location, and risk intelligence for an IPv4 or IPv6 address. Each lookup costs one credit, and failed lookups are free.

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient();

const info = await client.lookupIP("8.8.8.8");
if (info.intelligence) {
  console.log(info.intelligence.risk_score, info.intelligence.categories);
}
```

`network`, `location`, and `intelligence` are absent when the API has no data for that section, so check them before reading their fields. Response fields keep the API's snake_case names. The examples below reuse `client`. Runnable programs are in [examples](examples), for example `npm install && npm run build && node examples/lookup-ip.ts 8.8.8.8` with `SYNTHIENT_API_KEY` set, which needs Node.js 22.18 or later to run TypeScript directly.

### Look up many IP addresses

Look up as many as 1000 addresses in one request, billed at `ceil(n * 0.9)` credits for the `n` distinct addresses looked up. Private and reserved addresses are skipped and duplicates collapse into one result, so match results by `ip` rather than by position.

```ts
const results = await client.lookupIPs(["8.8.8.8", "1.1.1.1"]);
for (const result of results) {
  if (result.intelligence) {
    console.log(result.ip, result.intelligence.risk_score);
  }
}
```

### Look up a domain

Get the honeypot traffic observed for a domain, with its most recent events. A domain that has never been observed resolves with an `"inactive"` status and zero counts rather than an error. Each lookup costs one credit.

```ts
import { toDate } from "@synthient/synthient";

const domain = await client.lookupDomain("example.com", { limit: 10 });
console.log(domain.status, domain.stats.events_24h);
for (const event of domain.recent_events) {
  console.log(toDate(event.timestamp), event.target_subdomain, event.port);
}
```

### Check your account

Get the account that owns the API key, with the key's scopes and the team's remaining lookup credits. It costs no credits.

```ts
const account = await client.account();
console.log(account.organization.name, account.scopes, account.lookup_quota.credits);
```

## Available Resources and Operations

<details open>
<summary>Available methods</summary>

### Synthient

- `lookupIP` - Look up an IPv4 or IPv6 address
- `lookupIPs` - Look up as many as 1000 addresses in one request
- `lookupDomain` - Look up the honeypot traffic observed for a domain
- `account` - Get the account that owns the API key, the key's scopes, and the team's remaining lookup credits
- `health` - Check that the API and its dependencies are healthy

### Feeds

Each feed is a property of the client, such as `client.proxies`, and has the same methods:

- `stream` - Iterate over the feed's real-time events
- `listExports` - List one page of the feed's Parquet exports, newest first
- `allExports` - Iterate over every export, fetching pages as needed
- `exportMeta` - Get an export's checksum, size, row count, and Parquet schema
- `download` - Download an export's Parquet file
- `downloadURL` - Get a presigned URL for an export's Parquet file, valid for 24 hours

| Property      | Data                                          | Event type         | Stream scope            | Export scope          |
| ------------- | --------------------------------------------- | ------------------ | ----------------------- | --------------------- |
| `proxies`     | Residential, mobile, and datacenter proxies   | `ProxyEvent`       | `PROXY_FIREHOSE`        | `PROXY_FEEDS`         |
| `anonymizers` | VPN and anonymizer IP ranges                  | `AnonymizerEvent`  | `ANONYMIZERS_STREAM`    | `ANONYMIZERS_FEED`    |
| `torrents`    | BitTorrent DHT and tracker peers              | `TorrentEvent`     | `TORRENTS_STREAM`       | `TORRENTS_FEED`       |
| `ja4t`        | JA4T TCP fingerprints                         | `JA4TEvent`        | `JA4T_STREAM`           | `JA4T_FEED`           |
| `heliosHTTP`  | Helios honeypot HTTP requests                 | `HeliosHTTPEvent`  | `HONEYPOT_HTTP_STREAM`  | `HONEYPOT_HTTP_FEED`  |
| `heliosHTTPS` | Helios honeypot TLS ClientHellos              | `HeliosHTTPSEvent` | `HONEYPOT_HTTPS_STREAM` | `HONEYPOT_HTTPS_FEED` |
| `heliosDNS`   | Helios honeypot tunnel destinations           | `HeliosDNSEvent`   | `HONEYPOT_DNS_STREAM`   | `HONEYPOT_DNS_FEED`   |
| `heliosADB`   | Helios honeypot Android Debug Bridge commands | `HeliosADBEvent`   | `HONEYPOT_ADB_STREAM`   | `HONEYPOT_ADB_FEED`   |

</details>

## Streaming

`stream` returns an async iterator over a feed's real-time events. The connection opens when the loop starts, and breaking out of the loop closes it. The server keeps a stream open for up to 30 minutes and then closes it, which ends the loop without an error. The API has no resume cursor, so loop again to reconnect:

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { APIError } from "@synthient/synthient";

for (;;) {
  try {
    for await (const event of client.proxies.stream()) {
      console.log(event.ip, event.provider, event.type);
    }
  } catch (error) {
    if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
      throw error;
    }
    console.error("proxy stream:", error);
    // Pause after a failure so a failing stream doesn't reconnect in a tight loop.
    await sleep(2000);
  }
}
```

The loop stops on a 401 or 403, because reconnecting can't fix a rejected key or a missing scope. Other failures, such as a dropped connection or another non-success response, are thrown from the `for await` loop; the example logs them and waits 2 seconds before reconnecting. After the server's routine close, it reconnects at once. A 429 `APIError` without `retryAfter` means the key already has too many open streams. The server sends a keepalive about every 15 seconds, so a `timeout` longer than that only fires on a stalled connection.

## Pagination

`listExports` returns one page of a feed's exports, newest first:

```ts
const page = await client.proxies.listExports({ limit: 50 });
for (const item of page.feeds) {
  console.log(item.id, item.kind, item.row_count);
}
```

While `page.next_cursor` is a non-empty string, pass it as the `cursor` option to get the next page. It is absent, `null`, or empty on the last page, and a call without a cursor starts again from the first page. `allExports` does the paging for you. It fetches pages as the loop needs them and stops fetching when the loop breaks:

```ts
for await (const item of client.proxies.allExports()) {
  console.log(item.id, item.kind, item.row_count);
}
```

On the first page, the newest hourly export has the ID `latest`, a moving alias for the freshest export. To keep a stable ID, build it from the export's `date` and `hour`, such as `2026-10-14/21`.

## Downloads

Exports are Parquet files. Identify one by the `id` of an `Export` from a listing, by `"latest"` for the freshest one, or by `dailyExport(date)` or `hourlyExport(date)` for a UTC day or hour. `download` returns the file's contents as a web `ReadableStream`; read it to the end or cancel it to release the connection:

```ts
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const body = await client.proxies.download("latest");
await pipeline(Readable.fromWeb(body), createWriteStream("proxies.parquet"));
```

The file comes from a presigned storage URL that is requested without your API key. `exportMeta` returns the SHA-256 checksum to verify it against; ask both calls for the same stable ID, because `latest` can move to a newer export between them. `downloadURL` returns the presigned URL itself for tools that read Parquet over HTTPS. The URL grants access without a key for 24 hours, so treat it as a secret.

An hourly export is available until its day's daily export is rolled up, shortly after 00:30 UTC the next day. After that, requests for the hour return a 400. While a daily export is being rolled up, requests for it return a 404 with `retryAfter` set.

## Retries

The client retries a failed request up to twice by default, backing off exponentially with jitter and honoring `Retry-After`:

- Account and feed requests to the API are retried on 500, 502, 503, and 504 responses, on timeouts and connection failures such as a refused or reset connection, and on 429 responses that carry `Retry-After`. TLS failures are not retried, and neither is a download's request to the storage host or a failure while reading a stream or download.
- Billed lookups (`lookupIP`, `lookupIPs`, and `lookupDomain`) are retried only on 429 responses that carry `Retry-After`, which the rate limiter returns before doing any work, so a lookup is never charged twice. `health` is retried the same way, so an unhealthy API is reported at once.

A 429 without `Retry-After` means the key's monthly request budget is spent or it has too many open streams, so it is returned without a retry. A `Retry-After` longer than a minute is returned to you instead of waited out, and retries stop when the call's `signal` aborts.

To change the number of retries, pass `maxRetries` when creating the client. Zero disables retries:

```ts
const client = new Synthient({ maxRetries: 4 });
```

## Timeouts

The `timeout` option, in milliseconds (60,000 by default), limits how long the client waits for response headers or for the next part of a body, including streams and downloads. When it fires, the call rejects with an `APITimeoutError` once any retries are used up. It does not limit a whole call, because streams and downloads are long-lived. Bound a call, including its retries, with an `AbortSignal`:

```ts
const client = new Synthient({ timeout: 30_000 });

const info = await client.lookupIP("8.8.8.8", { signal: AbortSignal.timeout(10_000) });
```

Every method takes a `signal` option. An aborted call rejects with the signal's reason, which is a `TimeoutError` `DOMException` for `AbortSignal.timeout`.

## Error Handling

A request that fails with a non-success HTTP status rejects with an `APIError`. It has the following properties:

| Property     | Type                       | Description                                                                                              |
| ------------ | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `status`     | `number`                   | HTTP response status code, such as `404`                                                                 |
| `type`       | `string`                   | URI identifying the problem type, such as `https://docs.synthient.com/errors/validation-failed`, or `""` |
| `title`      | `string`                   | Short summary of the problem type, or `""`                                                               |
| `detail`     | `string`                   | Explanation of this occurrence, or `""`. For a plain-text error, the response body                       |
| `errors`     | `Record<string, string[]>` | Validation messages by request field                                                                     |
| `requestID`  | `string`                   | Request ID to give Synthient support, or `""`                                                            |
| `retryAfter` | `number \| undefined`      | Milliseconds the server asked you to wait before retrying, or `undefined` if it did not say              |

`message` holds only the HTTP status, so it is safe to log. The other properties hold untrusted server data that can be sensitive, so log them deliberately.

### Example

```ts
import { APIError } from "@synthient/synthient";

try {
  await client.lookupIP("8.8.8.8");
} catch (error) {
  if (!(error instanceof APIError)) {
    throw error;
  }
  switch (error.status) {
    case 402:
      console.log("out of lookup credits");
      break;
    case 429:
      if (error.retryAfter === undefined) {
        console.log("monthly request budget spent");
      } else {
        console.log(`rate limited, retry after ${error.retryAfter} ms`);
      }
      break;
    default:
      console.log("request", error.requestID, "failed:", error.detail || error.title);
  }
}
```

### Error Types

- `SynthientError`: the base class of the errors the SDK throws for failed requests and invalid responses.
  - `APIError`: the API, or the storage host serving an export download, returned a non-success status. A storage error carries only `status` and `retryAfter`.
  - `APIConnectionError`: the connection failed before a response arrived or while its body was being read, for example because of a DNS, connection, or TLS failure, or a stream that dropped. The underlying error is its `cause`, except when the storage host that serves an export download fails, where it is left out to keep presigned URLs out of errors.
    - `APITimeoutError`: no data arrived within the client's `timeout`. It has no `cause`.
- `TypeError` and `RangeError`: an argument or option is invalid, such as a missing API key or a malformed IP address.
- Aborted calls: a call whose `signal` aborts rejects with the signal's reason.

<details><summary>Status codes</summary>

<br />

| Status | Meaning                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | The request is invalid, such as asking for an hourly export that has been rolled up                                |
| 401    | The API key is malformed, unknown, or revoked                                                                      |
| 402    | The team is out of lookup credits                                                                                  |
| 403    | The key lacks the scope for the endpoint or feed                                                                   |
| 404    | The export does not exist, or a daily export is still being rolled up and `retryAfter` is set                      |
| 422    | The input is invalid, such as a private or reserved address, a malformed domain, or a batch with no usable address |
| 429    | With `retryAfter`, the rate limit was hit. Without it, the request budget is spent or too many streams are open    |
| 5xx    | The server failed. Account and feed requests are retried on 500, 502, 503, and 504                                 |

</details>

## Server Selection

### Override Server URL Per-Client

The default server is `https://api.synthient.com/api/v4`, exported as `DEFAULT_BASE_URL`. To send requests elsewhere, such as through a gateway or to a mock server in tests, pass `baseURL` when creating the client. The URL includes the version path:

```ts
const client = new Synthient({ baseURL: "http://localhost:8080/api/v4" });
```

## Custom HTTP Client

The client sends requests with the global `fetch`. Pass your own with the `fetch` option, for example to route requests through a proxy or to answer them with fixtures in tests:

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient({
  apiKey: "test-key",
  fetch: async () => Response.json({ ip: "8.8.8.8" }),
});

const info = await client.lookupIP("8.8.8.8");
```

The client also uses this `fetch` to download export files from the storage host, without the API key. A custom `fetch` must not follow redirects or replay requests itself: the client relies on seeing each redirect to keep the API key away from other hosts, and on sending each billed lookup once. It must also honor `init.signal`, which carries both the `timeout` and the call's `signal`.

To identify your application, `userAgent: "my-app/1.2"` appends a product token to the `User-Agent` header.

## Debugging

`onResponse` is called when each API response's headers arrive, including each retry, page, and stream handshake, and responses that fail to decode. It receives the status code, the request ID to give Synthient support, and a copy of the response headers, which include the operation's rate limit when the API sends one:

```ts
const client = new Synthient({
  onResponse: ({ status, requestID, headers }) => {
    console.log(`status=${status} request_id=${requestID}`);
    const remaining = headers.get("ratelimit-remaining");
    if (remaining !== null) {
      console.log(`rate limit: ${remaining} of ${headers.get("ratelimit-limit")} left`);
    }
  },
});
```

The hook runs synchronously and must not be async. If it throws, the error is reported with `process.emitWarning` and the call continues. Storage download responses are not passed to it.

> [!WARNING]
> Response headers can contain secrets, such as presigned download URLs. Avoid logging `headers` in production.

## gRPC Schema

The `@synthient/synthient/grpcschema` subpath fetches the protobuf schema of the [Synthient gRPC API](https://docs.synthient.com/grpc) through gRPC server reflection. It needs two optional peer dependencies:

```sh
npm add @grpc/grpc-js @bufbuild/protobuf
```

```ts
import { SchemaError, explain, fetchSchema } from "@synthient/synthient/grpcschema";

try {
  const schema = await fetchSchema();
  for (const file of schema.descriptorSet.file) {
    console.log(file.name, file.package);
  }
} catch (error) {
  const explanation = explain(error);
  if (error instanceof SchemaError && explanation !== "") {
    throw new Error(`${explanation} ${error.message}`, { cause: error });
  }
  throw error;
}
```

`fetchSchema` reads the key from `SYNTHIENT_API_KEY` unless you pass `apiKey`, and gives up after 30 seconds unless you pass a different `timeout` in milliseconds. `schema.descriptorSet` is a `FileDescriptorSet` from `@bufbuild/protobuf` with each file after the files it imports. `explain` describes common gRPC errors in plain language, and returns an empty string for the rest.

# Development

## Maturity

This SDK follows [Semantic Versioning](https://semver.org). Breaking changes to its public API ship only in a new major version. The 1.x versions of `@synthient/synthient` on npm are an older, deprecated client with a different API; this SDK starts at 2.0.0.

## Contributions

Bug reports and feature requests are welcome as [GitHub issues](https://github.com/synthient/synthient-node/issues). For questions about the API or your account, contact [Synthient support](https://docs.synthient.com/misc/support).

## License

[Apache 2.0](LICENSE)
