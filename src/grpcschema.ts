/**
 * Fetches the protobuf schema of the Synthient gRPC API using gRPC server reflection.
 * It needs the optional peer dependencies `@grpc/grpc-js` and `@bufbuild/protobuf`.
 *
 * @module
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  type FileDescriptorProto,
  type FileDescriptorSet,
} from "@bufbuild/protobuf/wkt";
import { Client, Metadata, credentials, status, type ServiceError } from "@grpc/grpc-js";
import { SynthientError } from "./errors.ts";
import { checkTimeout, resolveAPIKey } from "./options.ts";

export const DEFAULT_ENDPOINT = "grpc.synthient.com:443";

const MAX_MESSAGE_SIZE = 32 << 20;
const METHOD = "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo";
const FILE_BY_FILENAME = 3;
const FILE_CONTAINING_SYMBOL = 4;
const LIST_SERVICES = 7;

const EXPLANATIONS: Partial<Record<number, string>> = {
  [status.UNAUTHENTICATED]: "Missing or invalid API key.",
  [status.PERMISSION_DENIED]: "This API key does not have permission to inspect gRPC schemas.",
  [status.NOT_FOUND]:
    "No protobuf schema found for the requested symbol. Fetch without symbols to list the available services.",
  [status.UNIMPLEMENTED]: "The gRPC endpoint does not expose server reflection.",
  [status.UNAVAILABLE]:
    "Could not reach the gRPC endpoint. Check the address, network access, and TLS settings.",
  [status.DEADLINE_EXCEEDED]:
    "Timed out reading protobuf schemas from gRPC reflection. Use a longer timeout.",
};

export interface FetchSchemaOptions {
  /** Sent as x-api-key metadata when not empty. Defaults to the SYNTHIENT_API_KEY environment variable. */
  apiKey?: string | undefined;
  /**
   * The server as host:port, a bare host (port 443 is assumed), or a grpc:// or
   * https:// URL. Defaults to {@link DEFAULT_ENDPOINT}.
   */
  endpoint?: string | undefined;
  /** Disables TLS, for local development servers. */
  plaintext?: boolean | undefined;
  /**
   * Fully qualified service or message names to resolve. Empty resolves every listed
   * service except the grpc.reflection services.
   */
  symbols?: Iterable<string> | undefined;
  /** Cancels the fetch, which rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
  /** Milliseconds allowed for the whole fetch. Defaults to 30,000. */
  timeout?: number | undefined;
}

export interface Schema {
  /** The normalized address that was queried. */
  endpoint: string;
  /** The service or message names that were resolved. */
  symbols: string[];
  /** The resolved files in dependency order, each file after the files it imports. */
  descriptorSet: FileDescriptorSet;
}

/** Fetching the schema failed. {@link explain} describes common causes. */
export class SchemaError extends SynthientError {
  override name = "SchemaError";
  /**
   * The gRPC status code, as in `status` from `@grpc/grpc-js`, or undefined when the
   * failure was not a gRPC status.
   */
  readonly code: number | undefined;

  constructor(message: string, code?: number, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

interface Reply {
  files?: Uint8Array[];
  services?: string[];
  error?: { code: number; message: string };
}

/**
 * Fetches the protobuf files that define `options.symbols`, or every listed service,
 * along with all of their imports.
 */
export async function fetchSchema(options: FetchSchemaOptions = {}): Promise<Schema> {
  const { endpoint, host } = normalizeEndpoint(options.endpoint ?? "");
  const timeout = options.timeout ?? 30_000;
  checkTimeout(timeout);
  const signal = options.signal;
  signal?.throwIfAborted();

  const metadata = new Metadata();
  const apiKey = resolveAPIKey(options.apiKey);
  if (apiKey !== "") {
    metadata.set("x-api-key", apiKey);
  }
  const client = new Client(
    endpoint,
    options.plaintext ? credentials.createInsecure() : credentials.createSsl(),
    { "grpc.max_receive_message_length": MAX_MESSAGE_SIZE },
  );
  const call = client.makeBidiStreamRequest(
    METHOD,
    (request: Uint8Array) => Buffer.from(request),
    (response: Buffer) => response,
    metadata,
    { deadline: Date.now() + timeout },
  );
  const cancel = () => {
    call.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const replies: AsyncIterator<Buffer> = call[Symbol.asyncIterator]();

  // Sends every request before reading any reply; the server answers in request order.
  const ask = async (field: number, values: string[]): Promise<Reply[]> => {
    for (const value of values) {
      const request = new BinaryWriter()
        .tag(1, WireType.LengthDelimited)
        .string(host)
        .tag(field, WireType.LengthDelimited)
        .string(value)
        .finish();
      call.write(request);
    }
    const answers: Reply[] = [];
    while (answers.length < values.length) {
      const next = await replies.next();
      if (next.done) {
        throw new SchemaError("reflection stream ended early");
      }
      const reply = decodeReply(next.value);
      if (reply.error) {
        throw new SchemaError(reply.error.message || "reflection failed", reply.error.code);
      }
      answers.push(reply);
    }
    return answers;
  };

  const files = new Map<string, FileDescriptorProto>();
  const addFiles = (reply: Reply) => {
    if (!reply.files) {
      throw new SchemaError("reflection response has no file descriptors");
    }
    for (const bytes of reply.files) {
      let file: FileDescriptorProto;
      try {
        file = fromBinary(FileDescriptorProtoSchema, bytes);
      } catch (error) {
        throw new SchemaError("reflection returned an invalid file descriptor", undefined, {
          cause: error,
        });
      }
      if (!file.name) {
        throw new SchemaError("reflection returned a file descriptor without a name");
      }
      if (!files.has(file.name)) {
        files.set(file.name, file);
      }
    }
  };

  try {
    const requested = Array.from(options.symbols ?? [], (symbol) => symbol.trim());
    let symbols = [...new Set(requested)].filter((symbol) => symbol !== "");
    if (symbols.length === 0) {
      const [reply] = await ask(LIST_SERVICES, [""]);
      if (!reply?.services) {
        throw new SchemaError("reflection response has no service list");
      }
      symbols = reply.services
        .map((name) => name.trim())
        .filter((name) => name !== "" && !name.startsWith("grpc.reflection."))
        .sort();
    }
    if (symbols.length === 0) {
      throw new SchemaError("server lists no services");
    }

    for (const reply of await ask(FILE_CONTAINING_SYMBOL, symbols)) {
      addFiles(reply);
    }
    for (;;) {
      const imports = [...files.values()].flatMap((file) => file.dependency);
      const missing = [...new Set(imports)].filter((name) => !files.has(name)).sort();
      if (missing.length === 0) {
        break;
      }
      for (const reply of await ask(FILE_BY_FILENAME, missing)) {
        addFiles(reply);
      }
      const unresolved = missing.find((name) => !files.has(name));
      if (unresolved !== undefined) {
        throw new SchemaError(`reflection did not return dependency ${unresolved}`);
      }
    }

    return {
      endpoint,
      symbols,
      descriptorSet: create(FileDescriptorSetSchema, { file: dependencyOrder(files) }),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (
      error instanceof Error &&
      !(error instanceof SchemaError) &&
      "code" in error &&
      typeof error.code === "number"
    ) {
      const { details } = error as ServiceError;
      throw new SchemaError(details || "reflection failed", error.code, { cause: error });
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    call.on("error", () => undefined);
    call.cancel();
    client.close();
  }
}

/**
 * Converts `raw`, in any form {@link FetchSchemaOptions.endpoint} accepts, to host:port.
 * `host` is the bare host name, without brackets or a port.
 */
export function normalizeEndpoint(raw: string): { endpoint: string; host: string } {
  let value = raw.trim() || DEFAULT_ENDPOINT;
  if (value.includes("://")) {
    value = URL.parse(value)?.host ?? "";
  }
  value = value.replace(/\/$/, "");
  if (value === "") {
    throw new TypeError("empty gRPC endpoint");
  }

  let host = value;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    host = value.slice(1, close === -1 ? undefined : close);
    if (close !== -1 && value.slice(close + 1).startsWith(":")) {
      return { endpoint: value, host };
    }
  } else if (value.split(":").length === 2) {
    return { endpoint: value, host: value.slice(0, value.indexOf(":")) };
  }
  return { endpoint: host.includes(":") ? `[${host}]:443` : `${host}:443`, host };
}

/** Returns a human-readable explanation of a common fetch error, or "". */
export function explain(error: unknown): string {
  if (!(error instanceof SchemaError) || error.code === undefined) {
    return "";
  }
  return EXPLANATIONS[error.code] ?? "";
}

// Decodes a ServerReflectionResponse, keeping only the fields fetchSchema uses.
function decodeReply(bytes: Uint8Array): Reply {
  const reply: Reply = {};
  try {
    decode(bytes, (field, reader) => {
      if (field === 4) {
        const files: Uint8Array[] = [];
        decode(reader.bytes(), (inner, value) => {
          if (inner === 1) {
            files.push(value.bytes());
          }
        });
        reply.files = files;
      } else if (field === 6) {
        const services: string[] = [];
        decode(reader.bytes(), (inner, value) => {
          if (inner === 1) {
            decode(value.bytes(), (name, service) => {
              if (name === 1) {
                services.push(service.string());
              }
            });
          }
        });
        reply.services = services;
      } else if (field === 7) {
        const error: { code: number; message: string } = { code: status.UNKNOWN, message: "" };
        decode(reader.bytes(), (inner, value) => {
          if (inner === 1) {
            error.code = value.int32();
          } else if (inner === 2) {
            error.message = value.string();
          }
        });
        reply.error = error;
      }
    });
  } catch (error) {
    throw new SchemaError("invalid reflection response", undefined, { cause: error });
  }
  return reply;
}

// Fields the visitor leaves unread are skipped.
function decode(bytes: Uint8Array, visit: (field: number, reader: BinaryReader) => void): void {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    const start = reader.pos;
    visit(field, reader);
    if (reader.pos === start) {
      reader.skip(wireType, field);
    }
  }
}

function dependencyOrder(files: Map<string, FileDescriptorProto>): FileDescriptorProto[] {
  const ordered: FileDescriptorProto[] = [];
  const visited = new Set<string>();
  const visit = (name: string) => {
    const file = files.get(name);
    if (!file || visited.has(name)) {
      return;
    }
    visited.add(name);
    for (const dependency of [...file.dependency].sort()) {
      visit(dependency);
    }
    ordered.push(file);
  };
  for (const name of [...files.keys()].sort()) {
    visit(name);
  }
  return ordered;
}
