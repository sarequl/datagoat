#!/usr/bin/env bash
# Starts `wrangler dev` for the Playwright worker project: builds if needed, applies migrations to
# a fresh local D1 in .wrangler/e2e, and passes test secrets with --var (never real secrets).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f public/index.html ] || npm run build
rm -rf .wrangler/e2e
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e >/dev/null
exec npx wrangler dev --port "${E2E_WORKER_PORT:-8788}" --persist-to .wrangler/e2e --show-interactive-dev-session=false \
  --var SETUP_TOKEN:e2e-setup-token-0123456789 \
  --var SESSION_SECRET:e2e-session-secret-0123456789abcdef0123 \
  --var ENCRYPTION_KEY:e2e-encryption-key-0123456789abcdef012 \
  --var PASSWORD_ITERATIONS:10000
