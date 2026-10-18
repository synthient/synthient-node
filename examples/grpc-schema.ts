// Fetches the protobuf schema of the Synthient gRPC API through server reflection and
// prints its services and files. It needs the optional @grpc/grpc-js and
// @bufbuild/protobuf packages.
//
//   SYNTHIENT_API_KEY=... node examples/grpc-schema.ts
import { SchemaError, explain, fetchSchema } from "@synthient/synthient/grpcschema";

try {
  const schema = await fetchSchema();
  console.log("endpoint:", schema.endpoint);
  for (const symbol of schema.symbols) {
    console.log("service:", symbol);
  }
  for (const file of schema.descriptorSet.file) {
    console.log(`file: ${file.name} (package ${file.package})`);
  }
} catch (error) {
  const hint = explain(error);
  if (error instanceof SchemaError && hint !== "") {
    throw new Error(`${hint} ${error.message}`, { cause: error });
  }
  throw error;
}
