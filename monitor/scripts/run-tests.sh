#!/bin/bash
# electron/services の純関数テストを node --test で実行(esbuild でバンドル、外部依存なし)
set -e
cd "$(dirname "$0")/.."
OUT="${BUTLER_TEST_DIR:-/tmp/shirabe-tests}"
mkdir -p "$OUT"
npx esbuild electron/services/__tests__/butler.test.ts --bundle --platform=node --format=cjs --target=node20 --external:better-sqlite3 --outfile="$OUT/butler.test.cjs" --log-level=warning
NODE_PATH="$(pwd)/../mcp-server/node_modules" node --test "$OUT/butler.test.cjs"
