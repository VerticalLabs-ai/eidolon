#!/usr/bin/env bash
set -euo pipefail

local_db_url="postgresql://postgres:postgres@127.0.0.1:55322/postgres"

if [[ ! -f .env ]]; then
  if [[ -n "${CONDUCTOR_ROOT_PATH:-}" && -f "$CONDUCTOR_ROOT_PATH/.env" ]]; then
    cp "$CONDUCTOR_ROOT_PATH/.env" .env
  else
    cp .env.example .env
  fi
fi

if [[ ! -f .env.local && -n "${CONDUCTOR_ROOT_PATH:-}" && -f "$CONDUCTOR_ROOT_PATH/.env.local" ]]; then
  cp "$CONDUCTOR_ROOT_PATH/.env.local" .env.local
fi

tmp_env=".env.conductor.$$"
grep -v '^DATABASE_URL=' .env > "$tmp_env" || true
printf '\nDATABASE_URL=%s\n' "$local_db_url" >> "$tmp_env"
mv "$tmp_env" .env

pnpm install --frozen-lockfile
pnpm run db:start
env -u POSTGRES_URL_NON_POOLING -u POSTGRES_URL DATABASE_URL="$local_db_url" pnpm run db:migrate
