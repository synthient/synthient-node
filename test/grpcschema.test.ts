import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";
import {
  DEFAULT_ENDPOINT,
  SchemaError,
  explain,
  fetchSchema,
  normalizeEndpoint,
} from "../src/grpcschema.ts";
import { setAPIKeyEnv } from "./helpers.ts";

const GREETER = fileURLToPath(new URL("fixtures/greeter.proto", import.meta.url));
const REFLECTION = createRequire(import.meta.url).resolve(
  "@grpc/reflection/build/proto/grpc/reflection/v1/reflection.proto",
);
const METHOD = "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo";

type Handler = (call: grpc.ServerDuplexStream<unknown, unknown>) => void;

async function start(
  t: TestContext,
  register: (server: grpc.Server, keys: string[][]) => void,
): Promise<{ endpoint: string; keys: string[][] }> {
  const server = new grpc.Server();
  const keys: string[][] = [];
  register(server, keys);
  const bind = promisify(server.bindAsync.bind(server));
  const port = await bind("127.0.0.1:0", grpc.ServerCredentials.createInsecure());
  t.after(() => {
    server.forceShutdown();
  });
  return { endpoint: `127.0.0.1:${port}`, keys };
}

function reflection(server: grpc.Server, keys: string[][]): void {
  const pkg = loader.loadSync([GREETER, REFLECTION]);
  new ReflectionService(pkg).addToServer({
    addService: (service, implementation) => {
      const wrapped = Object.fromEntries(
        Object.entries(implementation).map(([name, handler]) => [
          name,
          (call: grpc.ServerDuplexStream<unknown, unknown>) => {
            keys.push(call.metadata.get("x-api-key").map(String));
            (handler as Handler)(call);
          },
        ]),
      );
      server.addService(service, wrapped);
    },
  });
}

function silent(server: grpc.Server): void {
  const identity = (value: Buffer) => value;
  server.addService(
    {
      ServerReflectionInfo: {
        path: METHOD,
        requestStream: true,
        responseStream: true,
        requestSerialize: identity,
        requestDeserialize: identity,
        responseSerialize: identity,
        responseDeserialize: identity,
      },
    },
    { ServerReflectionInfo: () => undefined },
  );
}

test("fetchSchema resolves every service and its imports in dependency order", async (t) => {
  const { endpoint, keys } = await start(t, reflection);

  const schema = await fetchSchema({ endpoint, plaintext: true, apiKey: " test-key " });

  assert.equal(schema.endpoint, endpoint);
  assert.deepEqual(schema.symbols, ["test.v1.Greeter"]);
  const files = schema.descriptorSet.file;
  const greeter = files.findIndex((file) => file.package === "test.v1");
  const timestamp = files.findIndex((file) => file.package === "google.protobuf");
  assert.ok(timestamp !== -1 && timestamp < greeter, files.map((file) => file.name).join(", "));
  assert.deepEqual(keys, [["test-key"]]);
});

test("fetchSchema honors symbols, including the reflection service", async (t) => {
  const { endpoint, keys } = await start(t, reflection);
  setAPIKeyEnv(t, undefined);

  const services = ["grpc.reflection.v1.ServerReflection", "test.v1.Greeter"];
  const withReflection = await fetchSchema({ endpoint, plaintext: true, symbols: services });
  const symbols = await fetchSchema({
    endpoint: `grpc://${endpoint}`,
    plaintext: true,
    symbols: [" test.v1.GreetReply ", "test.v1.GreetReply", ""],
  });

  assert.deepEqual(withReflection.symbols, services);
  assert.deepEqual(symbols.symbols, ["test.v1.GreetReply"]);
  assert.deepEqual(keys, [[], []]);
});

test("fetchSchema reports gRPC failures as SchemaError", async (t) => {
  const { endpoint } = await start(t, reflection);
  const empty = await start(t, () => undefined);

  await assert.rejects(
    fetchSchema({ endpoint, plaintext: true, symbols: ["test.v1.Missing"] }),
    (error: unknown) => {
      assert.ok(error instanceof SchemaError);
      assert.equal(error.code, grpc.status.NOT_FOUND);
      assert.match(error.message, /test\.v1\.Missing/);
      assert.match(explain(error), /No protobuf schema found/);
      return true;
    },
  );
  await assert.rejects(fetchSchema({ endpoint: empty.endpoint, plaintext: true }), (error) => {
    return error instanceof SchemaError && error.code === grpc.status.UNIMPLEMENTED;
  });
});

test("fetchSchema stops at its timeout or when aborted", async (t) => {
  const { endpoint } = await start(t, silent);

  await assert.rejects(fetchSchema({ endpoint, plaintext: true, timeout: 100 }), (error) => {
    assert.ok(error instanceof SchemaError);
    assert.equal(error.code, grpc.status.DEADLINE_EXCEEDED);
    assert.match(explain(error), /Timed out/);
    return true;
  });

  const controller = new AbortController();
  setTimeout(() => {
    controller.abort("stop");
  }, 50);
  await assert.rejects(
    fetchSchema({ endpoint, plaintext: true, signal: controller.signal }),
    (error) => error === "stop",
  );
  await assert.rejects(
    fetchSchema({ endpoint, plaintext: true, signal: AbortSignal.abort("early") }),
    (error) => error === "early",
  );
  await assert.rejects(fetchSchema({ endpoint, timeout: 0 }), RangeError);
});

test("normalizeEndpoint accepts hosts, host:port, and URLs", () => {
  const cases = [
    ["", DEFAULT_ENDPOINT, "grpc.synthient.com"],
    ["grpc.synthient.com", "grpc.synthient.com:443", "grpc.synthient.com"],
    ["localhost:50051/", "localhost:50051", "localhost"],
    ["grpc://localhost:50051", "localhost:50051", "localhost"],
    ["https://grpc.synthient.com", "grpc.synthient.com:443", "grpc.synthient.com"],
    ["[::1]:9000", "[::1]:9000", "::1"],
    ["::1", "[::1]:443", "::1"],
  ] as const;
  for (const [raw, endpoint, host] of cases) {
    assert.deepEqual(normalizeEndpoint(raw), { endpoint, host }, raw);
  }
  assert.throws(() => normalizeEndpoint("grpc://"), TypeError);
});

test("explain returns nothing for other errors", () => {
  assert.equal(explain(new Error("boom")), "");
  assert.equal(explain(new SchemaError("no code")), "");
});
