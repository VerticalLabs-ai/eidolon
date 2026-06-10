#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  export PORT="$CONDUCTOR_PORT"
  export UI_PORT="$((CONDUCTOR_PORT + 1))"
fi

exec pnpm run dev
