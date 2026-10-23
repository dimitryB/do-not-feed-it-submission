#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/runtime.sh
exec "$DNFI_NODE" node_modules/.bin/vinext dev "$@"
