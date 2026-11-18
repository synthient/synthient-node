// Checks the SDK against the OpenAPI spec it was last updated to, in .sdkgen/openapi.json.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Feed } from "../src/index.ts";
import { chunked, collect, json, newClient, redirect, stub } from "./helpers.ts";

interface SpecSchema {
  type?: string;
  $ref?: string;
  allOf?: SpecSchema[];
  nullable?: boolean;
  enum?: string[];
  "x-extensible-enum"?: string[];
  items?: SpecSchema;
  properties?: Record<string, SpecSchema>;
  required?: string[];
  additionalProperties?: SpecSchema | boolean;
}

interface Spec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, SpecSchema> };
}

const spec = JSON.parse(
  readFileSync(new URL("../.sdkgen/openapi.json", import.meta.url), "utf8"),
) as Spec;
const operations = Object.entries(spec.paths).flatMap(([path, methods]) => {
  return Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`);
});

const MODELS: Record<string, string> = {
  AccountInfoResponse: "Account",
  AccountAPIKey: "AccountAPIKey",
  Organization: "Organization",
  LookupQuota: "LookupQuota",
  IpProvidersResponse: "IPInfo",
  IntelligenceInfo: "Intelligence",
  DeviceInfo: "Device",
  ProviderEntry: "Provider",
  LocationInfo: "Location",
  NetworkInfo: "Network",
  ExportListResponse: "ExportPage",
  ExportListItem: "Export",
  ExportMetaResponse: "ExportMeta",
  ExportFormatFile: "ExportFile",
  ExportEntityFile: "ExportEntity",
  ExportDailyResponse: "ExportVolume",
  ExportDailyItem: "ExportVolumeDay",
  Schema: "ParquetSchema",
  ProjectedColumn: "ParquetColumn",
  ProxyStreamEntry: "ProxyEvent",
  AnonymizerStreamEntry: "AnonymizerEvent",
  TorrentStreamEntry: "TorrentEvent",
  TorrentFileEntry: "TorrentFile",
  TorrentPeerEntry: "TorrentPeer",
  JA4TStreamEntry: "JA4TEvent",
  HoneypotMeta: "HeliosMeta",
  HoneypotHTTPStreamEntry: "HeliosHTTPEvent",
  HoneypotHTTPSStreamEntry: "HeliosHTTPSEvent",
  HoneypotDNSStreamEntry: "HeliosDNSEvent",
  HoneypotADBStreamEntry: "HeliosADBEvent",
  TLSClientHello: "TLSClientHello",
  TLSCodeName: "TLSCodeName",
  TLSExtension: "TLSExtension",
};

// Integers the SDK keeps as exact decimal strings. The spec says int64, but live Helios
// tunnel IDs are unsigned 64-bit values above Number.MAX_SAFE_INTEGER.
const EXACT_INTEGERS = new Set([
  "HoneypotHTTPStreamEntry.tunnel_id",
  "HoneypotHTTPSStreamEntry.tunnel_id",
  "HoneypotDNSStreamEntry.tunnel_id",
]);

// Fields the spec made nullable after their types were released as optional. The client
// turns null into absent so those types stay true.
const NULL_AS_ABSENT = new Set([
  "AccountInfoResponse.api_key",
  "IpProvidersResponse.network",
  "IpProvidersResponse.location",
]);

// Enum values the spec dropped that stay in the SDK, deprecated, until the next major
// version.
const DEPRECATED_VALUES = new Set(["ADMIN_PROXIES"]);

// Operations the spec dropped that stay in the SDK, deprecated, until the next major
// version, with the client method that calls each.
const DEPRECATED_OPERATIONS: Record<string, string> = {
  "GET /lookup/domain/{domain}": "lookupDomain",
};

const UNMODELED: Record<string, string> = {
  IpBatchRequest: "lookupIPs encodes the request body",
  IpBatchResponse: "lookupIPs returns its results array",
  ProblemDetails: "parsed leniently into APIError",
  ValidationProblemDetails: "parsed leniently into APIError",
};

const program = ts.createProgram([fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
  strict: true,
  exactOptionalPropertyTypes: true,
  module: ts.ModuleKind.NodeNext,
  target: ts.ScriptTarget.ES2024,
  allowImportingTsExtensions: true,
  noEmit: true,
  types: ["node"],
});
const checker = program.getTypeChecker();
const interfaces = new Map<string, ts.Type>();
const clientMethods = new Map<string, ts.Node>();
for (const file of program.getSourceFiles()) {
  if (file.fileName.includes("/src/")) {
    ts.forEachChild(file, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        interfaces.set(node.name.text, checker.getTypeAtLocation(node));
      }
      if (ts.isClassDeclaration(node) && node.name?.text === "Synthient") {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member)) {
            clientMethods.set(member.name.getText(), member);
          }
        }
      }
    });
  }
}

// A closed enum must be exactly its string literals. An extensible one must be its
// literals plus `string & {}`, which accepts new values and keeps editor completions.
function enumMatches(values: string[], closed: boolean, type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  const literals = members
    .filter((member): member is ts.StringLiteralType => member.isStringLiteral())
    .map((member) => member.value)
    .filter((value) => !DEPRECATED_VALUES.has(value));
  const others = members.filter((member) => !member.isStringLiteral());
  const open = others.length === 1 && (others[0]?.flags ?? 0) & ts.TypeFlags.Intersection;
  return (
    literals.length === values.length &&
    values.every((value) => literals.includes(value)) &&
    (closed ? others.length === 0 : Boolean(open))
  );
}

function matches(schema: SpecSchema, type: ts.Type): boolean {
  const [single, ...rest] = schema.allOf ?? [];
  if (single !== undefined && rest.length === 0) {
    return matches(single, type);
  }
  const values = schema.enum ?? schema["x-extensible-enum"];
  if (values !== undefined) {
    return enumMatches(values, schema.enum !== undefined, type);
  }
  if (type.isUnion()) {
    return type.types.some((member) => matches(schema, member));
  }
  if (schema.$ref !== undefined) {
    const name = MODELS[schema.$ref.replace("#/components/schemas/", "")];
    return type.getSymbol()?.getName() === name;
  }
  switch (schema.type) {
    case "string":
      return (type.flags & ts.TypeFlags.StringLike) !== 0;
    case "integer":
    case "number":
      return (type.flags & ts.TypeFlags.NumberLike) !== 0;
    case "boolean":
      return (type.flags & ts.TypeFlags.BooleanLike) !== 0;
    case "array": {
      const [item] = checker.isArrayType(type)
        ? checker.getTypeArguments(type as ts.TypeReference)
        : [];
      return item !== undefined && schema.items !== undefined && matches(schema.items, item);
    }
    case "object": {
      if (schema.properties !== undefined) {
        return interfaces.has(type.getSymbol()?.getName() ?? "");
      }
      const values = checker.getIndexInfoOfType(type, ts.IndexKind.String)?.type;
      const additional = schema.additionalProperties;
      return (
        values !== undefined && (typeof additional !== "object" || matches(additional, values))
      );
    }
    default:
      return false;
  }
}

function mismatches(schemaName: string, schema: SpecSchema, typeName: string): string[] {
  const type = interfaces.get(typeName);
  if (!type) {
    return [`${typeName} is not an interface in src`];
  }
  const problems: string[] = [];
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const members = new Map(type.getProperties().map((symbol) => [symbol.getName(), symbol]));

  for (const [name, property] of Object.entries(properties)) {
    const member = members.get(name);
    if (!member) {
      problems.push(`${typeName} is missing ${schemaName}.${name}`);
      continue;
    }
    const optional = (member.getFlags() & ts.SymbolFlags.Optional) !== 0;
    if (optional === required.has(name)) {
      problems.push(
        `${typeName}.${name} is ${optional ? "optional" : "required"} but the spec disagrees`,
      );
    }
    const declared = checker.getTypeOfSymbol(member);
    const allowsNull =
      declared.isUnion() && declared.types.some((part) => part.flags & ts.TypeFlags.Null);
    if (property.nullable === true && !allowsNull && !NULL_AS_ABSENT.has(`${schemaName}.${name}`)) {
      problems.push(`${typeName}.${name} must allow null`);
    }
    const memberType = checker.getNonNullableType(declared);
    const inline =
      property.properties === undefined ? undefined : memberType.getSymbol()?.getName();
    if (inline !== undefined) {
      problems.push(...mismatches(`${schemaName}.${name}`, property, inline));
    }
    const expected = EXACT_INTEGERS.has(`${schemaName}.${name}`) ? { type: "string" } : property;
    if (!matches(expected, memberType)) {
      problems.push(
        `${typeName}.${name} has type ${checker.typeToString(memberType)}, not ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const name of members.keys()) {
    if (!(name in properties)) {
      problems.push(`${typeName}.${name} is not in ${schemaName}`);
    }
  }
  return problems;
}

test("every spec schema is modeled or deliberately skipped", () => {
  const accounted = [...Object.keys(MODELS), ...Object.keys(UNMODELED)].sort();
  assert.deepEqual(accounted, Object.keys(spec.components.schemas).sort());
});

test("interfaces match their spec schemas", () => {
  const problems = Object.entries(MODELS).flatMap(([schemaName, typeName]) => {
    const schema = spec.components.schemas[schemaName];
    return schema ? mismatches(schemaName, schema, typeName) : [`${schemaName} is not in the spec`];
  });
  assert.deepEqual(problems, []);
});

test("the client covers every spec operation, plus its deprecated ones", async () => {
  const { fetch, requests } = stub((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/stream")) {
      return chunked(["{}\n"]);
    }
    if (path.endsWith("/export/daily")) {
      return json(200, { stream: "x", days: [] });
    }
    if (path.endsWith("/lookup/ips")) {
      return json(200, { results: [] });
    }
    if (path.endsWith("/export")) {
      return json(200, { stream: "x", feeds: [] });
    }
    if (/\/export\/[^/]+(\/\d+)?$/.test(path)) {
      return redirect("https://storage.test/x");
    }
    return json(200, {});
  });
  const client = newClient({ fetch });

  await client.account();
  await client.health();
  await client.lookupIP("8.8.8.8");
  await client.lookupIPs(["8.8.8.8"]);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- covers a deprecated operation
  await client.lookupDomain("example.com");
  const feeds: Feed<object>[] = [
    client.proxies,
    client.anonymizers,
    client.torrents,
    client.ja4t,
    client.heliosHTTP,
    client.heliosHTTPS,
    client.heliosDNS,
    client.heliosADB,
  ];
  for (const feed of feeds) {
    await collect(feed.stream());
    await feed.listExports();
    await feed.exportVolume();
    await feed.exportMeta("2026-05-07");
    await feed.exportMeta("2026-05-07/21");
    await feed.downloadURL("2026-05-07");
    await feed.downloadURL("2026-05-07/21");
  }
  for (const dataset of [client.geolocation, client.whois]) {
    await dataset.listExports();
    await dataset.exportVolume();
    await dataset.exportMeta("2026-05-07");
    await dataset.downloadURL("2026-05-07");
  }

  const covered = new Set(
    requests.map((request) => {
      const path = new URL(request.url).pathname
        .replace(/^\/api\/v4/, "")
        .replace(/^\/lookup\/ip\/.+/, "/lookup/ip/{ip_address}")
        .replace(/^\/lookup\/domain\/.+/, "/lookup/domain/{domain}")
        .replace(/\/export\/\d{4}-\d{2}-\d{2}/, "/export/{date}")
        .replace(/\/export\/\{date\}\/\d+/, "/export/{date}/{hour}");
      return `${request.method} ${path}`;
    }),
  );
  assert.deepEqual(
    [...covered].sort(),
    [...operations, ...Object.keys(DEPRECATED_OPERATIONS)].sort(),
  );
});

test("operations the spec dropped are deprecated", () => {
  for (const [operation, method] of Object.entries(DEPRECATED_OPERATIONS)) {
    assert.ok(!operations.includes(operation), `${operation} is back in the spec`);
    const node = clientMethods.get(method);
    assert.ok(node && ts.getJSDocDeprecatedTag(node), `${method} is not deprecated`);
  }
});
