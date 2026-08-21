#!/bin/sh
set -eu

PORT="${PORT:-8787}"
MISUB_RUNTIME="${MISUB_RUNTIME:-cloudflare}"
D1_NAME="${D1_NAME:-misub}"
PERSIST_DIR="${PERSIST_DIR:-/data/wrangler}"
MISUB_SQLITE_PATH="${MISUB_SQLITE_PATH:-/data/misub.sqlite}"
COMPATIBILITY_DATE="${COMPATIBILITY_DATE:-2024-04-01}"
DEV_VARS_FILE=".dev.vars"

mkdir -p "${PERSIST_DIR}"

cat > "${DEV_VARS_FILE}" <<EOF
ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin}
MISUB_RUNTIME=${MISUB_RUNTIME}
MISUB_STORAGE_TYPE=${MISUB_STORAGE_TYPE:-}
MISUB_SQLITE_PATH=${MISUB_SQLITE_PATH}
COOKIE_SECRET=${COOKIE_SECRET:-}
CRON_SECRET=${CRON_SECRET:-}
CORS_ORIGINS=${CORS_ORIGINS:-}
MISUB_PUBLIC_URL=${MISUB_PUBLIC_URL:-}
MISUB_CALLBACK_URL=${MISUB_CALLBACK_URL:-}
MISUB_SKIP_TLS_VERIFY=${MISUB_SKIP_TLS_VERIFY:-true}
EOF

npm run build

# Ensure local D1 schema exists before starting Pages dev runtime.
if [ "${MISUB_RUNTIME}" != "container" ]; then
  npx wrangler d1 execute "${D1_NAME}" --local --file=schema.sql --persist-to "${PERSIST_DIR}" >/dev/null 2>&1 || true
fi

if [ "${MISUB_RUNTIME}" = "container" ]; then
  exec node ./docker/node-server.mjs
fi

exec npx wrangler pages dev dist \
    --ip 0.0.0.0 \
    --port "${PORT}" \
    --compatibility-date "${COMPATIBILITY_DATE}" \
    --kv MISUB_KV \
    --d1 "MISUB_DB=${D1_NAME}" \
    --persist-to "${PERSIST_DIR}"