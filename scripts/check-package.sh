#!/bin/sh
# Packs the package and checks it the way consumers install it: package metadata, ESM
# and CommonJS loading, the optional grpcschema peers, and TypeScript consumers on the
# oldest and newest supported compilers.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$root"
npm pack --silent --pack-destination "$work" > /dev/null
tarball=$(ls "$work"/*.tgz)
npx publint --strict "$root"
npx attw "$tarball" --profile esm-only

cd "$work"
npm init -y > /dev/null
npm pkg set type=module
npm install --silent --no-audit --no-fund "$tarball"
cp "$root"/test/package/* .
node esm.mjs
node cjs.cjs

if node -e 'await import("@synthient/synthient/grpcschema")' 2> missing.txt; then
  echo "grpcschema loaded without its peer dependencies" >&2
  exit 1
fi
if ! grep -Eq "@grpc/grpc-js|@bufbuild/protobuf" missing.txt; then
  cat missing.txt >&2
  exit 1
fi
npm install --silent --no-audit --no-fund @grpc/grpc-js @bufbuild/protobuf
node -e 'const m = await import("@synthient/synthient/grpcschema"); if (typeof m.fetchSchema !== "function") process.exit(1)'

for typescript in 5.8 6.0 7.0; do
  for types in 22 latest; do
    echo "typescript $typescript, @types/node $types"
    npm install --silent --no-audit --no-fund "typescript@~$typescript" "@types/node@$types"
    npx tsc -p tsconfig.nodenext.json
    npx tsc -p tsconfig.bundler.json
  done
done
echo "package ok"
