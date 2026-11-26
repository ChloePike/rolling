# Deploy runbook

One Worker per environment (`apps/api/wrangler.jsonc`): `rolling-api-staging` (`--env staging`) and
`rolling-api` (`--env production`). The Cloudflare account is shared with other projects: only touch
resources named `rolling-*` (Analytics Engine: `rolling_<env>`).

## Environments

| | Staging | Production |
|---|---|---|
| URL | https://staging.rolling.actor (+ `rolling-api-staging.swiftpayx.workers.dev`) | https://rolling.actor (`www.` → 301 to apex in the Worker; no workers.dev URL) |
| D1 | `rolling-staging` | `rolling-production` (`2e3081cc-a516-4d5d-93dd-6dfc8748939a`) |
| R2 (MEDIA, SPA under `_web/`) | `rolling-media-staging` | `rolling-media-production` (CORS: `https://rolling.actor`, PUT/GET/HEAD) |
| Queues (+ `-dlq`) | `rolling-staging-{media-process,ledger-mirror,notify-email}` | `rolling-production-{media-process,ledger-mirror,notify-email}` |
| Workflows | `rolling-staging-{generate,export,billing}` | `rolling-production-{generate,export,billing}` |
| Public media (D-008) | `rolling-public-staging` on https://media-staging.rolling.actor | `rolling-public-production` on https://media.rolling.actor |
| Private media (D-008) | https://cdn-private-staging.rolling.actor (Worker custom domain, signed URLs only) | https://cdn-private.rolling.actor |
| Container app | `rolling-api-ffmpegrenderer-staging` | `rolling-api-ffmpegrenderer-production` (max 20) |
| Email | `EMAIL` binding; `EMAIL_PROVIDER=test-inbox` (e2e reads codes from `/api/test/inbox`) | `EMAIL` binding; `EMAIL_PROVIDER=cloudflare` |

## Deploy

The SPA is served from R2 because Workers static-asset uploads fail through this sandbox's proxy
(`apps/api/src/lib/r2Static.ts`). Docker must be running (FFmpeg container image).

```sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=e2ed20c61e6c1ce394300a753734eff9
./scripts/deploy/staging-r2.sh       # staging
./scripts/deploy/production-r2.sh    # production
```

Each script builds `apps/web`, uploads `dist/` to `_web/` in the environment's bucket (index.html last),
then runs `wrangler deploy --env <env>` with the `assets` block stripped. A CI runner that can upload
Workers assets can run `wrangler deploy --env <env>` directly instead.

D1 migrations (before a deploy that needs them):

```sh
cd apps/api
npx wrangler d1 migrations apply rolling-staging --remote --env staging
npx wrangler d1 migrations apply rolling-production --remote --env production
```

Seed data comes only from migrations (`0016_seed_templates.sql`, ...). Never copy staging data to production.

## Secrets (`wrangler secret put <NAME> --env <env>`)

| Secret | Production | Without it |
|---|---|---|
| `BETTER_AUTH_SECRET` | set (generated) | auth refuses to start |
| `MEDIA_SIGNING_KEY` | set (generated) | signed private media URLs fail |
| `GOOGLE_CLIENT_ID` | set (public Web client id, D-017) | Google button hidden; email code only |
| `HYPEROUTER_API_KEY` | **owner** | agent turns and new runs answer `503` ("not available right now"); the 6-hourly model catalog sync fails (logged) and `/api/models` lists none |
| `HYPEROUTER_WEBHOOK_SECRET` | **owner** | `POST /api/hooks/hyperouter` answers `503 Webhooks are not configured` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | **owner** (R2 API token scoped to `rolling-media-production`) | uploads answer `503 Uploads are not configured` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **owner** | checkout/portal answer `503 Payments are not configured`; nobody can buy a plan, so members-only features stay closed |
| `RESEND_API_KEY` | optional | only needed with `EMAIL_PROVIDER=resend` (fallback) |
| `TEST_INBOX_TOKEN` | never | staging only; `/api/test/*` are refused in production |

Generate server secrets without printing them: `openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put BETTER_AUTH_SECRET --env production`.

## Email (Cloudflare Email Service, D-015)

- `rolling.actor` is onboarded for sending (zone → Email Service → Sending domains; API
  `POST /zones/{zone}/email/sending/subdomains {"name":"rolling.actor"}`). Message previews are off
  (`PATCH .../subdomains/{id} {"preview_enabled":false}`) so sign-in codes are not stored in the activity log.
- DNS added by onboarding (locked, managed by Cloudflare): `cf-bounce.rolling.actor` MX ×3
  (`route{1,2,3}.mx.cloudflare.net`) and TXT `v=spf1 include:_spf.mx.cloudflare.net ~all` (return path),
  TXT `cf-bounce._domainkey.rolling.actor` (DKIM). The apex SPF (`v=spf1 include:_spf.mx.cloudflare.net ~all`)
  and Email Routing MX/DKIM are unchanged (one SPF record).
- DMARC: `_dmarc.rolling.actor` TXT `v=DMARC1; p=none; rua=mailto:abuse@rolling.actor` (onboarding creates
  `p=reject`; we replaced it with `p=none` while sending is verified). Tighten later.
- Check status: `GET /zones/{zone}/email/sending/subdomains/{id}/dns/status` → `ready`.
- Sender `Rolling <no-reply@rolling.actor>` (`EMAIL_FROM`), reply-to `support@rolling.actor`.
- Account quota at onboarding: 1,000 messages/day, arbitrary recipients.

## Media hosts (D-008)

- Public: R2 buckets `rolling-public-<env>` with R2 custom domains (API
  `POST /accounts/{id}/r2/buckets/{bucket}/domains/custom {"domain","zoneId","enabled":true,"minTLS":"1.2"}`) and CORS
  (`PUT .../cors`, GET/HEAD from the app origins, exposes Content-Range/ETag). Objects carry
  `Cache-Control: public, max-age=31536000, immutable`. Only non-mature library images and template covers go there.
- Private: `cdn-private[-staging].rolling.actor` are `routes` (custom domains) of the env's Worker; created by
  `wrangler deploy`. Only signed `/media/<key>?exp=&ws=&sig=` URLs are answered.
- `rolling-media-<env>` CORS also allows the app origin for direct uploads (staging: `https://staging.rolling.actor`).

```sh
K=public/pose/pw_pose_full_single_P001/front.webp
curl -sI https://media.rolling.actor/$K                     # 200, cache-control: public, max-age=31536000, immutable
curl -s -o /dev/null -w '%{http_code}\n' https://cdn-private.rolling.actor/media/$K   # 403 (unsigned)
curl -s -o /dev/null -w '%{http_code}\n' https://cdn-private.rolling.actor/          # 404
```

## Verify after a deploy

```sh
for p in / /login /terms /privacy /acceptable-use /subprocessors /api/health /api/auth/providers; do
  curl -s -o /dev/null -w "$p %{http_code}\n" https://rolling.actor$p; done   # all 200, no redirect
curl -s https://rolling.actor/api/auth/providers   # google.loginUri = https://rolling.actor/api/auth/google/credential
curl -s -o /dev/null -w '%{http_code}\n' https://rolling.actor/api/test/inbox   # 404
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.rolling.actor/terms   # 301 → apex
```

## Follow-ups

- Public library (PoseWear, D-004) is imported in both envs (same counts); CharaDB images are not copied yet
  (`scripts/posewear/README.md` → Live state, refresh commands).
- Stripe products/prices for production (`pnpm --filter @rolling/api stripe:sync`) once keys exist; webhook
  `https://rolling.actor/api/stripe/webhook`. Hyperouter webhook `https://rolling.actor/api/hooks/hyperouter`.

## Workers Builds (Git-connected deploys)

Both Workers deploy from `ChloePike/rolling` through Workers Builds, which builds the FFmpeg container image itself and uploads the SPA as Workers static assets (the R2 `_web/` path is only a fallback for deploys from sandboxes that cannot upload assets).

| Worker | Branch | Root directory | Build command | Deploy command |
|---|---|---|---|---|
| `rolling-api` (production) | `main` | `/` | `pnpm run build:ci` | `pnpm --filter @rolling/api run deploy:production:ci` |
| `rolling-api-staging` | `main` | `/` | `pnpm run build:ci` | `pnpm --filter @rolling/api run deploy:staging:ci` |

- Non-production branch builds stay off: these Workers use Durable Objects and Containers, so preview versions cannot serve the full app.
- The deploy commands apply pending D1 migrations first; the build token needs D1 Edit in addition to the default Workers permissions.
- Secrets stay in each Worker's settings; nothing secret lives in the repository or the build variables.
