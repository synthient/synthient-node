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
  - [Installation](#installation)
  - [Quick start](#quick-start)
  - [Authentication](#authentication)
  - [Available Resources and Operations](#available-resources-and-operations)
  - [IP and domain lookups](#ip-and-domain-lookups)
  - [Account](#account)
  - [Feeds](#feeds)
  - [Errors](#errors)
  - [Retries and timeouts](#retries-and-timeouts)
  - [Configuration](#configuration)
  - [Response metadata](#response-metadata)
  - [gRPC Schema](#grpc-schema)
  - [Requirements](#requirements)
  - [Versioning](#versioning)
  - [Documentation](#documentation)
- [Development](#development)
  - [Contributions](#contributions)
  - [License](#license)

## Installation

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
> This package is an ES module. CommonJS code can also load it with `require()`.

The [gRPC schema fetcher](#grpc-schema) is the `@synthient/synthient/grpcschema` subpath of the same package.

## Quick start

This program creates a client and looks up one address. It reads the API key from the `SYNTHIENT_API_KEY` environment variable, and each lookup costs one credit.

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient();

const info = await client.lookupIP("8.8.8.8");
console.log(info.ip, info.network?.isp, info.network?.type);
if (info.intelligence) {
  console.log(info.intelligence.risk_score, info.intelligence.categories);
}
```

The examples below reuse `client`, and runnable programs are in [examples](examples). See the [Node SDK guide](https://docs.synthient.com/sdks/node) for a walkthrough.

## Authentication

### API Keys

Every request needs a Synthient API key. Keys are issued from the Synthient dashboard; if you don't have one, [contact us](mailto:contact@synthient.com). A key's scopes decide what it can call: `BASIC` covers the lookups and `account`, and each feed has its own scopes, listed under [Feeds](#feeds). See [Authentication](https://docs.synthient.com/authentication) for how keys and scopes work.

If a request fails even though you are sending a key:

- **401 Unauthorized**: the key is malformed, unknown, or revoked.
- **402 Payment Required**: the team is out of lookup credits.
- **403 Forbidden**: the key lacks the scope for that endpoint or feed.

`account` shows the key's scopes and the team's remaining credits.

### Passing the key

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

Here `getSecret` stands for your own code. A missing key throws a `TypeError`.

The constructor makes no network calls. To check a key, call `account`, which costs no credits.

## Available Resources and Operations

<details open>
<summary>Available methods</summary>

### Synthient

- `lookupIP` - Look up an IPv4 or IPv6 address
- `lookupIPs` - Look up as many as 1000 addresses in one request
- `lookupDomain` - Look up the honeypot traffic observed for a domain
- `account` - Get the key's account, scopes, and remaining lookup credits
- `health` - Check that the API and its dependencies are healthy

### Feed

Each feed is a property of the client, such as `client.proxies`, and has the same methods:

- `stream` - Iterate over the feed's real-time events
- `listExports` - List one page of the feed's Parquet exports, newest first
- `allExports` - Iterate over every export, fetching pages as needed
- `exportMeta` - Get an export's checksum, size, row count, and Parquet schema
- `download` - Download an export's Parquet file
- `downloadURL` - Get a presigned URL for an export's Parquet file, valid for 24 hours

The feeds and their scopes are listed under [Feeds](#feeds).

</details>

## IP and domain lookups

See [Lookups](https://docs.synthient.com/sdks/node/lookups) for every method and [Types](https://docs.synthient.com/sdks/node/types) for the fields of each response.

### Look up an IP address

Get the network, location, and risk intelligence for an IPv4 or IPv6 address. Each lookup costs one credit; failed lookups are free.

```ts
const info = await client.lookupIP("8.8.8.8");
if (info.intelligence) {
  console.log(info.intelligence.risk_score, info.intelligence.categories);
}
```

`network`, `location`, and `intelligence` are absent when the API has no data for them. Response fields keep the API's snake_case names. A string that is not an IP address throws a `TypeError` without a request, and a private or reserved address rejects with a 422 `APIError`.

### Look up many IP addresses

Look up as many as 1000 addresses in one request for `ceil(n * 0.9)` credits. Private and reserved addresses are skipped and duplicates are merged, so match results by `ip`.

```ts
const results = await client.lookupIPs(["8.8.8.8", "1.1.1.1"]);
for (const result of results) {
  if (result.intelligence) {
    console.log(result.ip, result.intelligence.risk_score);
  }
}
```

`lookupIPs` takes any iterable of strings, such as an array or a `Set`. An empty one resolves to `[]` without a request, and a batch with no usable address rejects with a 422 `APIError`.

### Look up a domain

Get the honeypot traffic observed for a domain and its most recent events. Each lookup costs one credit.

```ts
import { toDate } from "@synthient/synthient";

const domain = await client.lookupDomain("example.com", { limit: 10 });
console.log(domain.status, domain.stats.events_24h);
for (const event of domain.recent_events) {
  console.log(toDate(event.timestamp), event.target_subdomain, event.port);
}
```

- `limit` caps the number of recent events. The API default is 50, and it clamps values above 1000.
- A domain that was never observed resolves with `status` `"inactive"` and zeroed stats.
- Internationalized names must be sent in Punycode.

### Timestamps

Timestamps are Unix times as the API sends them: in seconds, except the `timestamp` of anonymizer and Helios HTTP, HTTPS, and DNS stream events, which is in milliseconds. `toDate` converts either to a `Date`.

## Account

### Check your account

Get the key's account, scopes, and remaining lookup credits, at no cost.

```ts
const account = await client.account();
console.log(account.organization.name, account.scopes, account.lookup_quota.credits);
```

### Check the API's health

`health` resolves if the API and its dependencies are healthy. An unhealthy API rejects with a 503 `APIError`.

```ts
await client.health();
```

## Feeds

Each feed is a property of the client with a real-time stream and hourly Parquet exports that roll up into daily exports. Streaming and exports need separate scopes. See [Feeds](https://docs.synthient.com/sdks/node/feeds) for every method, and [Firehose](https://docs.synthient.com/enterprise/firehose) and [Feeds](https://docs.synthient.com/enterprise/feeds) for the data behind them.

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

### Streaming

`stream` returns an async iterator over a feed's real-time events. Each `for await` loop opens a connection, and breaking out of the loop closes it:

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
    // Avoid reconnecting in a tight loop.
    await sleep(2000);
  }
}
```

- The server closes each stream after up to 30 minutes. That ends the inner loop without an error, and the outer loop reconnects at once.
- A 401 or 403 stops the loop, because reconnecting can't fix a rejected key or a missing scope.
- Any other failure is thrown from the inner loop, and the outer loop waits 2 seconds before reconnecting.
- Events sent while disconnected are missed. The API has no resume cursor.
- The client's `timeout` bounds the gap between data, and the server sends a keepalive about every 15 seconds.
- A Helios `tunnel_id` is an unsigned 64-bit integer, so the SDK keeps it as a string of its exact decimal digits.

### Pagination

`listExports` returns one page of a feed's exports, newest first. Pass `page.next_cursor` as `cursor` to get the next page; it is absent, `null`, or empty on the last one.

```ts
const page = await client.proxies.listExports({ limit: 50 });
for (const item of page.feeds) {
  console.log(item.id, item.kind, item.row_count);
}
```

`allExports` fetches the pages for you as the loop needs them:

```ts
for await (const item of client.proxies.allExports()) {
  console.log(item.id, item.kind, item.row_count);
}
```

On the first page, the newest hourly export has the ID `latest`, a moving alias for the freshest export. Its `date` and `hour` give its stable ID, such as `2026-10-14/21`.

`limit` sets the page size. The API default is 100, and it clamps values above 500.

### Downloads

Exports are Parquet files. `download` returns a file's contents as a web `ReadableStream`, which you must read to the end or cancel:

```ts
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const body = await client.proxies.download("latest");
await pipeline(Readable.fromWeb(body), createWriteStream("proxies.parquet"));
```

- Name an export by its `id` from a listing, by `"latest"`, or by `dailyExport(date)` or `hourlyExport(date)` for a UTC day or hour.
- `exportMeta` returns the file's SHA-256 checksum. Use a fixed ID for both calls, because `latest` can move between them.
- `downloadURL` returns a presigned URL that works without a key for 24 hours, so treat it as a secret. Your API key is never sent to the storage host.
- Hourly exports roll into the daily export shortly after 00:30 UTC the next day. After that, the hour returns a 400.

`dailyExport` and `hourlyExport` build an export ID from a `Date`, and `exportMeta` describes the file before you download it:

```ts
import { dailyExport } from "@synthient/synthient";

const yesterday = dailyExport(new Date(Date.now() - 24 * 60 * 60 * 1000));
const meta = await client.proxies.exportMeta(yesterday);
console.log(meta.id, meta.rows, meta.size, meta.checksum);
for (const column of meta.schema.fields) {
  console.log(column.name, column.type);
}
```

The SDK does not verify a download. [examples/download-export.ts](examples/download-export.ts) compares a file's SHA-256 with its checksum.

## Errors

See [Errors and retries](https://docs.synthient.com/sdks/node/errors) for the SDK's error classes and [Errors](https://docs.synthient.com/errors) for what each status means.

A request that fails with a non-success status rejects with an `APIError`:

| Property     | Type                       | Description                                               |
| ------------ | -------------------------- | --------------------------------------------------------- |
| `status`     | `number`                   | HTTP status code, such as `404`                           |
| `type`       | `string`                   | URI identifying the problem type, or `""`                 |
| `title`      | `string`                   | Short summary of the problem type, or `""`                |
| `detail`     | `string`                   | Explanation of this occurrence, or `""`                   |
| `errors`     | `Record<string, string[]>` | Validation messages by request field                      |
| `requestID`  | `string`                   | Request ID to give Synthient support, or `""`             |
| `retryAfter` | `number \| undefined`      | Milliseconds the server asked you to wait, or `undefined` |

`message` holds only the HTTP status, so it is safe to log. The other properties hold untrusted server data.

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
  - `APIError`: the API, or the storage host during `download`, returned a non-success status.
  - `APIConnectionError`: the connection failed, such as a DNS or TLS failure or a dropped stream. The underlying error is its `cause`, except for storage host failures during `download`.
    - `APITimeoutError`: no data arrived within the client's `timeout`.
  - `SchemaError`: fetching the [gRPC schema](#grpc-schema) failed. It is exported from `@synthient/synthient/grpcschema`.
- `TypeError` and `RangeError`: an argument or option is invalid, such as a missing API key or a malformed IP address.
- Aborted calls: a call whose `signal` aborts rejects with the signal's reason.

<details><summary>Status codes</summary>

<br />

| Status | Meaning                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| 400    | The request is invalid, such as an hourly export that was rolled up                             |
| 401    | The API key is malformed, unknown, or revoked                                                   |
| 402    | The team is out of lookup credits                                                               |
| 403    | The key lacks the scope for the endpoint or feed                                                |
| 404    | The export doesn't exist, or a daily export is still rolling up (`retryAfter` is set)           |
| 422    | The input is invalid, such as a private address or a malformed domain                           |
| 429    | Rate limited if `retryAfter` is set; otherwise the budget is spent or too many streams are open |
| 5xx    | The server failed                                                                               |

</details>

## Retries and timeouts

### Retries

The client retries a failed request up to twice, backing off exponentially with jitter and honoring `Retry-After`:

| Requests                    | Retried on                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Account and feed requests   | 500, 502, 503, and 504, timeouts, most connection failures, and 429 with `Retry-After`       |
| Billed lookups and `health` | Only 429 with `Retry-After`, which comes before any work, so a lookup is never charged twice |

A 429 without `Retry-After` means the monthly request budget is spent or too many streams are open, so the call fails at once. Downloads from the storage host are never retried.

Set the number of retries with `maxRetries`. Zero disables them:

```ts
const client = new Synthient({ maxRetries: 4 });
```

Retries back off from one second, doubling up to 30 seconds. A `Retry-After` longer than 60 seconds is not retried: the call rejects with the response's `APIError`. See [Rate Limits](https://docs.synthient.com/rate-limits) for the limits themselves.

### Timeouts

The `timeout` option, in milliseconds (60,000 by default), limits how long the client waits for response headers or for the next part of a body. It doesn't limit a whole call, because streams and downloads are long-lived. Bound a call with an `AbortSignal`:

```ts
const client = new Synthient({ timeout: 30_000 });

const info = await client.lookupIP("8.8.8.8", { signal: AbortSignal.timeout(10_000) });
```

Every method takes a `signal` option. An aborted call rejects with the signal's reason.

## Configuration

Pass options to the constructor. All of them are optional. See [Client](https://docs.synthient.com/sdks/node/client) for the details of each.

| Option       | Type                                   | Default                            | Description                                                          |
| ------------ | -------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `apiKey`     | `string`                               | `SYNTHIENT_API_KEY`                | The API key                                                          |
| `baseURL`    | `string`                               | `https://api.synthient.com/api/v4` | The API base URL, including the version path                         |
| `maxRetries` | `number`                               | `2`                                | How many times a failed request is retried; `0` disables retries     |
| `timeout`    | `number`                               | `60_000`                           | Milliseconds to wait for response headers or the next part of a body |
| `fetch`      | `Fetch`                                | global `fetch`                     | The fetch implementation                                             |
| `userAgent`  | `string`                               | none                               | Appended to the `User-Agent` header                                  |
| `onResponse` | `(metadata: ResponseMetadata) => void` | none                               | Called after every API response                                      |

An invalid option throws a `TypeError` or `RangeError` from the constructor. Create one client and reuse it for every request.

### Server Selection

The default server is `https://api.synthient.com/api/v4`, exported as `DEFAULT_BASE_URL`. Use `baseURL` to send requests elsewhere, such as a mock server in tests:

```ts
const client = new Synthient({ baseURL: "http://localhost:8080/api/v4" });
```

### Custom HTTP Client

The client uses the global `fetch`. Pass your own with the `fetch` option, for example to use a proxy or to answer requests with fixtures in tests:

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient({
  apiKey: "test-key",
  fetch: async () => Response.json({ ip: "8.8.8.8" }),
});

const info = await client.lookupIP("8.8.8.8");
```

- Your `fetch` also downloads exports from the storage host, without the API key.
- It must not follow redirects, because the client handles each one to keep the API key away from other hosts.
- It must not replay requests, so a billed lookup is never sent twice.
- It must honor `init.signal`, which carries the `timeout` and the call's `signal`.

`userAgent: "my-app/1.2"` adds your product token to the `User-Agent` header. The header starts with `synthient-node/` and the SDK version, which is exported as `VERSION`.

## Response metadata

`onResponse` is called after every API response, including retries, pages, and stream handshakes, with the status, request ID, and headers:

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

The hook must be synchronous. An error it throws is emitted as a process warning, and the call continues. Download responses from the storage host are not reported.

The SDK has no rate limit type. Read the `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers from `headers` instead, as above.

> [!WARNING]
> Response headers can contain secrets, such as presigned download URLs. Avoid logging `headers` in production.

## gRPC Schema

The `@synthient/synthient/grpcschema` subpath fetches the protobuf schema of the [Synthient gRPC API](https://docs.synthient.com/grpc) through server reflection. It needs two optional peer dependencies:

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

`fetchSchema` reads the key from `SYNTHIENT_API_KEY` unless you pass `apiKey`. `schema.descriptorSet` is a `FileDescriptorSet` from `@bufbuild/protobuf/wkt`. `explain` describes common gRPC errors in plain language. A `SchemaError` carries the gRPC status as `code`, or `undefined` when the failure was not a gRPC status.

`fetchSchema` takes these options, all optional:

| Option      | Type               | Default                  | Description                                                              |
| ----------- | ------------------ | ------------------------ | ------------------------------------------------------------------------ |
| `apiKey`    | `string`           | `SYNTHIENT_API_KEY`      | Sent as `x-api-key` metadata when not empty                              |
| `endpoint`  | `string`           | `grpc.synthient.com:443` | The server as `host:port`, a bare host, or a `grpc://` or `https://` URL |
| `plaintext` | `boolean`          | `false`                  | Disables TLS, for local development servers                              |
| `symbols`   | `Iterable<string>` | every listed service     | Fully qualified service or message names to resolve                      |
| `signal`    | `AbortSignal`      | none                     | Cancels the fetch, which rejects with the signal's reason                |
| `timeout`   | `number`           | `30_000`                 | Milliseconds allowed for the whole fetch                                 |

The default endpoint is exported as `DEFAULT_ENDPOINT`. See [gRPC schema](https://docs.synthient.com/sdks/node/grpc-schema) for the full reference.

## Requirements

Node.js 22.12 or later. Other runtimes, such as Bun and Deno, are not tested. The SDK is for server-side code and has no runtime dependencies. Its types are tested with TypeScript 5.8 and later.

## Versioning

This SDK follows [Semantic Versioning](https://semver.org). Breaking changes ship only in a new major version. The 1.x versions on npm are an older, deprecated client with a different API.

## Documentation

- [Node SDK](https://docs.synthient.com/sdks/node): getting started
- [Client](https://docs.synthient.com/sdks/node/client): options, request options, and response metadata
- [Lookups](https://docs.synthient.com/sdks/node/lookups): IP, batch, and domain lookups, `account`, and `health`
- [Feeds](https://docs.synthient.com/sdks/node/feeds): streams and Parquet exports
- [Errors and retries](https://docs.synthient.com/sdks/node/errors): error classes, retries, and timeouts
- [Types](https://docs.synthient.com/sdks/node/types): the fields of every response and event type
- [gRPC schema](https://docs.synthient.com/sdks/node/grpc-schema): the `grpcschema` subpath
- [IP API](https://docs.synthient.com/ipapi), [Authentication](https://docs.synthient.com/authentication), [Rate Limits](https://docs.synthient.com/rate-limits), and [Errors](https://docs.synthient.com/errors): the HTTP API behind the SDK

# Development

## Contributions

Bug reports and feature requests are welcome as [GitHub issues](https://github.com/synthient/synthient-node/issues). For questions about the API or your account, contact [Synthient support](https://docs.synthient.com/misc/support).

## License

[Apache 2.0](LICENSE)
