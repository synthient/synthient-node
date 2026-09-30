# synthient-node

![Synthient](assets/readme-header.svg)

[![npm](https://img.shields.io/npm/v/@synthient/synthient)](https://www.npmjs.com/package/@synthient/synthient)
[![test](https://github.com/synthient/synthient-node/actions/workflows/test.yml/badge.svg)](https://github.com/synthient/synthient-node/actions/workflows/test.yml)
[![lint](https://github.com/synthient/synthient-node/actions/workflows/lint.yml/badge.svg)](https://github.com/synthient/synthient-node/actions/workflows/lint.yml)

The official Node.js client for the [Synthient API](https://docs.synthient.com): IP and domain intelligence, account details, and real-time and bulk data feeds.

## Install

```sh
npm install @synthient/synthient
```

Requires Node.js 22.12 or later. The package is ESM only; CommonJS code can `require()` it.

## Usage

```ts
import { Synthient } from "@synthient/synthient";

const client = new Synthient(); // reads SYNTHIENT_API_KEY

const info = await client.lookupIP("8.8.8.8");
console.log(info.network?.isp, info.intelligence?.risk_score);
```

Look up many addresses in one request:

```ts
const results = await client.lookupIPs(["8.8.8.8", "1.1.1.1"]);
for (const result of results) {
  console.log(result.ip, result.intelligence?.risk_score);
}
```

Consume a real-time feed:

```ts
for await (const event of client.proxies.stream()) {
  console.log(event.ip, event.provider);
}
```

## Documentation

Every class and method is documented in its TSDoc, including errors, retries, exports, and downloads. Runnable programs are in [examples](examples), for example `npm run build && node examples/lookup-ip.ts 8.8.8.8`. Guides and field references are at [docs.synthient.com](https://docs.synthient.com). The `@synthient/synthient/grpcschema` module fetches the protobuf schema of the Synthient gRPC API; it needs `npm install @grpc/grpc-js @bufbuild/protobuf`.

## License

[Apache 2.0](LICENSE)
