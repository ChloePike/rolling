#!/usr/bin/env bash
# Deploys production (https://rolling.actor) with the SPA served from R2 instead of Workers static assets.
# Same flow as staging-r2.sh: web build -> upload apps/web/dist to `_web/` in rolling-media-production ->
# `wrangler deploy --env production` with the `assets` block stripped (apps/api/src/lib/r2Static.ts serves it).
# Use this where Workers asset uploads are not possible; a CI deploy can use `wrangler deploy --env production`.
# Runbook: docs/deploy.md.
set -euo pipefail
if ! docker image inspect node:22-slim >/dev/null 2>&1; then
  docker pull mirror.gcr.io/library/node:22-slim && docker tag mirror.gcr.io/library/node:22-slim node:22-slim
fi
cd "$(dirname "$0")/../.."
pnpm --filter @rolling/web build
R2_BUCKET=rolling-media-production NODE_USE_ENV_PROXY=1 packages/core/node_modules/.bin/tsx scripts/deploy/upload-web.mts
cd apps/api
python3 - <<'PY'
import re
s = open('wrangler.jsonc').read()
s = re.sub(r'\n  "assets": \{.*?\n  \},', '', s, count=1, flags=re.S)
open('wrangler.r2web.jsonc', 'w').write(s)
PY
trap 'rm -f wrangler.r2web.jsonc' EXIT
npx wrangler deploy -c wrangler.r2web.jsonc --env production
