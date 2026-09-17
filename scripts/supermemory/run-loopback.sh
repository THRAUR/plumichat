#!/usr/bin/env bash
# Start a self-hosted supermemory-server on loopback only (Linux).
#
#   scripts/supermemory/run-loopback.sh [env-file]
#
# The env file (default ~/.supermemory/env) holds the server's own settings: its
# extraction model key, SUPERMEMORY_DATA_DIR, the embedding model. It is sourced
# into a CLEAN environment, because the server reads PORT before SUPERMEMORY_PORT
# and a shell that started PlumiChat usually exports PlumiChat's PORT.
#
# Build the shim once, next to this script:
#   gcc -O2 -Wall -shared -fPIC -o scripts/supermemory/bind-loopback.so \
#       scripts/supermemory/bind-loopback.c -ldl
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-$HOME/.supermemory/env}"
SHIM="$HERE/bind-loopback.so"
BIN="${SUPERMEMORY_BIN:-$(command -v supermemory-server || echo "$HOME/.supermemory/bin/supermemory-server")}"
SM_PORT="${SUPERMEMORY_PORT:-6767}"

[ -f "$SHIM" ] || { echo "missing $SHIM — build it first (see the header of this script)" >&2; exit 1; }
[ -x "$BIN" ] || { echo "supermemory-server not found; set SUPERMEMORY_BIN" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }

exec env -i HOME="$HOME" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" PATH="/usr/local/bin:/usr/bin:/bin" \
  bash -c 'set -a; . "$1"; set +a; export PORT="$2" SUPERMEMORY_PORT="$2" LD_PRELOAD="$3"; exec "$4"' \
  _ "$ENV_FILE" "$SM_PORT" "$SHIM" "$BIN"
