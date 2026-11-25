#!/usr/bin/env bash
# Deploys staging with the SPA served from R2 instead of Workers static assets.
# Use this where Workers asset uploads are not possible (see apps/api/src/lib/r2Static.ts).
# CI deploys should use `pnpm --filter @rolling/api deploy:staging` instead.
set -euo pipefail
# The FFmpeg container's base image: pull it through Google's Docker Hub mirror so the build
# doesn't depend on Docker Hub, which rate-limits anonymous pulls (HTTP 429).
if ! docker image inspect node:22-slim >/dev/null 2>&1; then
  docker pull mirror.gcr.io/library/node:22-slim && docker tag mirror.gcr.io/library/node:22-slim node:22-slim
fi
cd "$(dirname "$0")/../.."
pnpm --filter @rolling/web build
R2_BUCKET=rolling-media-staging NODE_USE_ENV_PROXY=1 packages/core/node_modules/.bin/tsx scripts/deploy/upload-web.mts
cd apps/api
python3 - <<'PY'
import re
s = open('wrangler.jsonc').read()
s = re.sub(r'\n  "assets": \{.*?\n  \},', '', s, count=1, flags=re.S)
open('wrangler.r2web.jsonc', 'w').write(s)
PY
trap 'rm -f wrangler.r2web.jsonc' EXIT
npx wrangler deploy -c wrangler.r2web.jsonc --env staging
