#!/bin/bash
# esbuild で TS をバンドルしてから Node で実行(tsx 不要)
set -e
cd "$(dirname "$0")/.."
OUT="${BUTLER_DRYRUN_DIR:-/tmp/shirabe-butler-dryrun}"
mkdir -p "$OUT"
npx esbuild scripts/butler-dryrun.ts --bundle --platform=node --format=cjs --target=node20 --external:better-sqlite3 --outfile="$OUT/dryrun.cjs" --log-level=warning
NODE_PATH="$(pwd)/../mcp-server/node_modules" BUTLER_DRYRUN_DIR="$OUT" node "$OUT/dryrun.cjs" "$@"
