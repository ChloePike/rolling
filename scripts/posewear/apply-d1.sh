#!/usr/bin/env bash
# Applies out/sql/import-*.sql (written by emit-sql.ts) to the D1 database of one environment.
#   scripts/posewear/apply-d1.sh staging|production
# Idempotent (upserts; asset_search rows are replaced). Prints the per-category counts afterwards.
set -euo pipefail
env="${1:?usage: apply-d1.sh staging|production}"
case "$env" in
  staging) db=rolling-staging ;;
  production) db=rolling-production ;;
  *) echo "unknown env: $env" >&2; exit 1 ;;
esac
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/apps/api"
for f in "$root"/scripts/posewear/out/sql/import-*.sql; do
  echo "== $(basename "$f")"
  npx wrangler d1 execute "$db" --remote --env "$env" --yes --file "$f" >/dev/null
done
npx wrangler d1 execute "$db" --remote --env "$env" --command \
  "SELECT category, license, mature, count(*) AS n FROM public_items GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"
