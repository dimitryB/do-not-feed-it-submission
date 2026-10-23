#!/usr/bin/env bash
# Sourced by local launchers. Prefer the user's Node installation.
set -euo pipefail
if command -v node >/dev/null 2>&1; then
  DNFI_NODE="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  DNFI_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "Install Node.js 22.13+ and npm, then run npm ci." >&2
  exit 1
fi
export PATH="$(dirname "$DNFI_NODE"):$PATH"
export WRANGLER_LOG_PATH=".wrangler/logs"
export WRANGLER_SEND_METRICS=false
export WRANGLER_WRITE_LOGS=false
