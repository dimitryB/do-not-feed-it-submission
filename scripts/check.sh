#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/runtime.sh
"$DNFI_NODE" node_modules/.bin/tsc --noEmit
"$DNFI_NODE" node_modules/.bin/eslint .
"$DNFI_NODE" --experimental-strip-types --test tests/*.test.mjs
"$DNFI_NODE" node_modules/.bin/hardhat test nodejs --build-profile production
"$DNFI_NODE" node_modules/.bin/vinext build
