# Decisions log

Decisions made after the original spec. Where this file disagrees with `PRD.md`, `architecture.md`, `api.md` or `harness.md`, this file wins. Newest first.

## D-017 — Google sign-in uses popups / One Tap (ID tokens); redirect is the fallback; no Apple (2026-11-26)

Owner decision. Social sign-in does not leave the page, Google is the only social provider (Apple is removed: button, SDK, provider, client-secret signing, env, copy) and Google needs **only the public Client ID** (no `GOOGLE_CLIENT_SECRET`, no OAuth code exchange).

- **In place:** the login and sign-up pages load Google Identity Services (`https://accounts.google.com/gsi/client`) lazily and render the official button (popup, theme follows light/dark, width of the design button) and One Tap (`use_fedcm_for_prompt: true`, `auto_select: false`, `cancel_on_tap_outside: true`) for signed-out visitors; the plans page (`/upgrade`) shows One Tap to signed-out visitors. Each attempt uses a nonce from `GET /api/auth/nonce` (single use, 5 min, stored hashed). The ID token goes to Better Auth's ID-token sign-in (`POST /api/auth/sign-in/social` with `idToken`), which verifies it against Google's JWKS (`aud`, `iss`, `exp`); we add the nonce and `email_verified` checks.
- **Fallbacks:** a closed or blocked popup (and the installed app) switches GIS to redirect mode (`ux_mode: 'redirect'`, `login_uri` = `<origin>/api/auth/google/credential`; Google posts `credential` + `g_csrf_token`, checked double-submit). When the script cannot load at all, the design's own button goes to `GET /api/auth/google/start` (OIDC `response_type=id_token`, `response_mode=form_post` to the same endpoint, `state` cookie double-submit). Settings links Google through the same start route. Better Auth's `/callback/*` and `/link-social` are closed.
- **No CSP** is set by the Worker today; if one is added, allow `https://accounts.google.com` (script, frame, connect, and `https://accounts.google.com/gsi/style` for styles) on the auth and plans pages.
- **Origins:** `PUBLIC_APP_URL` plus the comma-separated `EXTRA_TRUSTED_ORIGINS` var (staging: `https://rolling-api-staging.swiftpayx.workers.dev` next to `https://staging.rolling.actor`). Better Auth trusts both; `login_uri` / `redirect_uri` follow the origin the user is on.

What the owner configures in Google Cloud Console → APIs & Services → Credentials → OAuth client (Web application):

| Field | Values |
|---|---|
| Authorized JavaScript origins | `https://rolling.actor`, `https://staging.rolling.actor`, `https://rolling-api-staging.swiftpayx.workers.dev`, `http://localhost:5173` (dev SPA), `http://localhost` (GIS also asks for this when testing on localhost) |
| Authorized redirect URIs | Needed for the fallbacks (GIS redirect mode requires `login_uri` to be listed here; the OIDC form post uses it as `redirect_uri`): `https://rolling.actor/api/auth/google/credential`, `https://staging.rolling.actor/api/auth/google/credential`, `https://rolling-api-staging.swiftpayx.workers.dev/api/auth/google/credential`, `http://localhost:8787/api/auth/google/credential` (local Worker). The old `/api/auth/callback/google` entries can be deleted. |
| OAuth consent screen | App name, support email, the `/terms` and `/privacy` URLs (D-016), authorized domain `rolling.actor` |

Worker config: `GOOGLE_CLIENT_ID` only (secret or var; it is public). Delete any `GOOGLE_CLIENT_SECRET` and `APPLE_*` secrets. `CLAUDE.md`, `PRD.md` and `milestones.md` still list Apple; this entry wins.

## D-016 — Legal pages at fixed public URLs (2026-11-26)

Owner decision. The drafts live in `legal/*.md` (repo root; “Draft for legal review — not yet in effect” until counsel signs off). They are bundled into the SPA at build time (`?raw` imports) and rendered by a small built-in Markdown parser (`apps/web/src/features/legal`, no new dependency).

| Path | Document |
|---|---|
| `/terms` | `legal/terms-of-service.md` — registered with Google OAuth, must not move |
| `/privacy` | `legal/privacy-policy.md` — registered with Google OAuth, must not move |
| `/acceptable-use` | `legal/acceptable-use-policy.md` |
| `/subprocessors` | `legal/subprocessors.md` |

- Public: in the session guard's public list, no sign-in and no redirect away; the Worker's SPA fallback (`not_found_handling: single-page-application`, or the R2-served shell) answers direct loads with `index.html`. `/legal/<doc>` paths redirect to the canonical ones.
- Linked from the log-in/sign-up consent line, the Help dialog, the plans page footer, the delete-account dialog (privacy, deletion section) and the footer of user emails (`renderEmail(…, appUrl)`).
- Contacts: `privacy@`, `legal@`, `abuse@`, `support@rolling.actor` (D-015). Company name, address, governing law and effective date stay placeholders.

## D-015 — Domain: rolling.actor (2026-11-26)

The product domain is `rolling.actor` (Cloudflare zone in the account; product name stays “Rolling” pending a rename).

| Host | Purpose |
|---|---|
| `rolling.actor` | Production app + API (Worker custom domain); `www.rolling.actor` redirects to it |
| `staging.rolling.actor` | Staging app + API (replaces the workers.dev URL) |
| `media.rolling.actor` | Public media bucket via CDN (D-008); `PUBLIC_MEDIA_BASE_URL` |
| `cdn-private.rolling.actor` | Signed private media (D-008); `PRIVATE_MEDIA_BASE_URL` (staging: `media-staging.` / `cdn-private-staging.`) |

- **Email (Cloudflare Email Service):** send from `no-reply@rolling.actor` (sign-in codes, invites, receipts); Email Preview off (sign-in codes); DMARC starts at `p=none` while sending is verified, then tightens. Inbound via Email Routing: `support@`, `privacy@`, `legal@`, `abuse@` forward to the owner.
- **Google sign-in URIs:** superseded by D-017 (no OAuth callback; Google posts to `/api/auth/google/credential`). Apple sign-in is dropped.
- **Stripe webhooks:** `https://rolling.actor/api/stripe/webhook`, staging equivalent. **Hyperouter webhook:** `https://rolling.actor/api/hooks/hyperouter` (and staging).
- **Live (2026-11-26):** production Worker `rolling-api` on custom domains `rolling.actor` and `www.rolling.actor` (the Worker answers `www` with a 301 to the apex; no workers.dev URL), D1 `rolling-production`, R2 `rolling-media-production` (SPA under `_web/`), queues `rolling-production-*` with DLQs, workflows `rolling-production-*`, container app `rolling-api-ffmpegrenderer-production`, AE `rolling_production`. Public pages, email-code sign-in and Google sign-in work; secrets set: `BETTER_AUTH_SECRET`, `MEDIA_SIGNING_KEY`, `GOOGLE_CLIENT_ID`. Paid and model features stay off until the owner sets `HYPEROUTER_*`, `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` and `STRIPE_*` (they answer 503 meanwhile). Runbook: `docs/deploy.md`.
- **Email live:** `rolling.actor` onboarded to Email Service sending (return path `cf-bounce.rolling.actor`, DKIM selector `cf-bounce`, previews off); `send_email` binding `EMAIL` (no destination restriction) on staging and production; `EMAIL_PROVIDER=cloudflare` in production (Resend stays an optional fallback), staging keeps `test-inbox` for e2e. `_dmarc` is `v=DMARC1; p=none; rua=mailto:abuse@rolling.actor`.

## D-014 — One global WebSocket per browser, multiplexed by channel (2026-11-25)

Owner decision; refines D-003 (WebSocket-first realtime).

- **One connection per browser**, held by a `SharedWorker` on the client and shared by every tab. It connects to `/api/ws`; the user's `UserHub` DO (hibernation API) is the gateway. Per-project sockets (`/api/projects/:id/ws`) are deprecated and removed once the web client has switched.
- **Channels.** Every server message carries `channel: 'user' | 'project'`; project messages add `projectId` and, for replayable events, `seq` (the project's event cursor). User-channel events (`credits.changed`, `prefs.changed`, `activity.updated`, `agent.allowance`, `notification`, Home/tool agent streams) go to all of the user's sockets.
- **Client messages:** `subscribe { channel: 'project', projectId, lastRevision?, lastSeq? }` (workspace membership checked; reply `subscribed { projectId, revision, seq, canEdit, snapshot | events }`), `unsubscribe { projectId }`, `patch { projectId, baseRevision, ops }` (run as the user through `ProjectRoom.applyPatch`; reply `ack` / `conflict` with the client message id), `undo` / `redo { projectId }`, `timeline.patch { canvasId, baseRevision, ops }`, `snapshot { projectId }`, `ping`.
- **Fan-out.** ProjectRoom keeps the set of subscribed UserHub ids and sends every event (`graph.patched`, `node.version`, `job.*`, `timeline.patched`, `proposal.*`, `agent.*`) to them by RPC; each hub forwards to its sockets subscribed to that project (the sender of a patch gets the `ack`, not its own `graph.patched`). A hub without subscribed sockets is dropped.
- **Catch-up.** ProjectRoom keeps a ring of the newest 500 replayable events (`seq`, revision). A resubscribe with `lastSeq` (or `lastRevision`) gets the gap when the ring still covers it, else a fresh snapshot.
- **Errors.** Connection-level refusals are accepted then closed with `4401` / `4403` / `4404` after one `error` message (browsers cannot read failed-upgrade responses); per-subscription errors arrive as `error { projectId, code }` on the open connection.
- Contract: `docs/api.md` → Global WebSocket; envelope schema in `packages/core/src/graph/envelope.ts`.

## D-013 — Team plan with purchased seats; personal plans have one seat (2026-11-25)

Owner decision. Values live in `packages/core/pricing/config.ts` (`PLANS.team`, `SEAT_PRICE`, `teamIncludedCredits`, `teamConcurrentJobs`, `teamAgentAllowanceUsd`, `teamPriceCents`, `planMonthlyCredits/ConcurrentJobs/AgentAllowanceUsd(plan, seats)`); `team.test.ts` enforces the margin floor.

- **Personal plans:** Starter, Plus and Pro have 1 seat each (Pro no longer includes 10 seats). Only Team workspaces can invite.
- **Team** (id `team`, plan order Starter, Plus, Pro, Team): base **$79/month or $758/year** including 1 seat (the owner); Pro perks (4K video and image caps, voice cloning), +10% top-up bonus; per month **2,500 shared plan credits**, **$12.50 agent allowance** (D-012), **10 jobs at once**.
- **Each additional seat: $25/month or $240/year**, adding +500 shared plan credits/month, +2 jobs at once (max 30) and +$3/month agent allowance. Seats = members including the owner; pending invites reserve a seat. Seats 1–200.

| Team seats | Monthly | Yearly | Credits/month | Jobs at once | Agent allowance/month |
|---|---|---|---|---|---|
| 1 | $79 | $758 | 2,500 | 10 | $12.50 |
| 3 | $129 | $1,238 | 3,500 | 14 | $18.50 |
| 5 | $179 | $1,718 | 4,500 | 18 | $24.50 |
| 11+ | +$25/seat | +$240/seat | +500/seat | 30 (max) | +$3/seat |

- **Margin floor for Team: ≥ 60% worst case** (every included credit and the whole agent allowance used, card fees 4.65% + $0.30 per charge, 2% infrastructure), monthly and yearly, for the base and for every additional seat (also checked per seat on its own, with its own $0.30). Base: 66.6% monthly, 60.3% yearly; seat: 73.5% monthly, 69.9% yearly. Personal plans keep the 50% floor.
- **Gating:** inviting without Team → `402 TEAM_REQUIRED { currentPlan }`; beyond purchased seats → `402 SEATS_REQUIRED { seats, used, needed }`. Accepting an invite turns its reserved seat into a member; removing a member or revoking an invite frees the seat. The purchased count stays until the owner lowers it; lowering below seats in use → `409 SEATS_IN_USE`.
- **Stripe:** one subscription, two items: base `rolling_team_<interval>` (quantity 1) and per-seat `rolling_team_seat_<interval>` (quantity seats − 1). `POST /api/billing/checkout {kind:'plan', planId:'team', interval, seats}`; `PATCH /api/billing/seats {seats}`. Increases: `proration_behavior: always_invoice` with `payment_behavior: pending_if_incomplete` (charged now, applied only once paid). Decreases: `proration_behavior: none` — effective now, no refund or credit for the rest of the period, the next invoice charges fewer seats. (Chosen over `create_prorations`: a prorated refund after the seat's credits were granted would let a workspace add and remove seats for free credits.)
- **Credits for added seats:** the prorated share of 500 credits per added seat for the rest of the current month slice, granted once per slice (`CreditAccount.setSeats`, high-water mark: removing and re-adding a seat in the same slice grants nothing new). Applied from the `PATCH` response and again (no-op) from `customer.subscription.updated` / `invoice.paid`; the next slice grants the full amount for the seats held then.
- **Personal → Team:** the simpler correct option — the workspace converts in place. Its subscription switches items (prorated, charged now), the workspace keeps its id, projects, assets and credits and becomes `kind: 'team'`; `invoice.paid` grants Team credits for the seats (leftover plan credits of the old slice expire, as on any upgrade). Starting Team from a workspace without a plan uses Checkout and converts the workspace the same way. A Team that later moves to a personal plan stays `kind: 'team'` but cannot invite; existing members stay.
- **Existing Pro workspaces with extra members** (from the old 10-seat Pro) keep them; new invites need Team.
- Supersedes D-006's seat column and the PRD's “Teams (Studio)” rule (which D-006 had moved to Pro).

## D-012 — Agent allowance: monthly USD of gateway cost per plan, held and settled per turn (2026-11-25)

Owner decision; replaces the daily turn limits (D-007) and resolves D-009's open item on premium agent LLMs.

- **Allowance per plan** (`AGENT_ALLOWANCE_USD`, `packages/core/pricing/config.ts`), in USD of Hyperouter cost per month: **Starter $1.20, Plus $3.50, Pro $12.50** (Team: `planAgentAllowanceUsd`, D-013). Members only (D-007). It resets on the plan's billing period start: monthly slices from the subscription's `current_period_start` (yearly plans reset monthly on the same day), else the calendar month in UTC.
- **Margin.** Sized so each plan keeps gross margin ≥ 50% in the worst case: plan price × 0.5 ≥ cost of all included credits + card fees (4.65% + $0.30) + 2% infra + the whole allowance (Starter $2.50 ≥ $2.50, Plus $7.50 ≥ $7.46, Pro $24.50 ≥ $24.39 at monthly prices; `config.test.ts` asserts it). With the yearly discount the monthly worst case dips below 50% (Starter ≈ 46%); real allowance use is far lower — accepted with monitoring (amendment below).
- **What a turn costs:** the sum of `usage.cost` of every Hyperouter response in the turn (all LLM calls, retries, the thread summary when it runs); a response without `cost` is priced as tokens × the resolved gateway model's `tokenPrice`. Classifier calls (Auto model choice, safety checks) are never charged to the allowance.
- **Holds, like credits.** The CreditAccount DO (one per workspace) keeps an agent allowance ledger in micro-USD: `agentHold` reserves the turn's estimate before the first LLM call and refuses with `AGENT_ALLOWANCE_EXHAUSTED` when used + held + estimate > allowance; `agentSettle` charges the actual cost (may exceed the hold; the overrun is recorded); `agentRelease` drops the hold of a turn that cost nothing (cancel, failure before a response); holds older than 10 minutes expire on the DO alarm (crashed turns; a late settle still charges). A turn in flight may overrun slightly; that is accepted.
- **Estimate** for the chosen public LLM: the rolling average of that model's last 20 settled turns in the workspace; without history, token prices × 10k prompt + 1.2k completion tokens (e.g. DeepSeek V4.1 Flash ≈ $0.0011, Claude Opus 5.5 $0.064, GPT-6 Astra $0.16 → Starter ≈ 1,081 / 18 / 7 turns).
- **API:** `429 AGENT_ALLOWANCE_EXHAUSTED { allowanceUsd, usedUsd, resetsAt, model }` on send; `GET /api/agent/allowance` → `{ plan, allowanceUsd, usedUsd, resetsAt, models: [{ id, name, estTurnUsd, turnsLeft }] }` (public LLM ids only); `agent.allowance` with the same payload on the user socket after each turn. D1 `agent_usage` keeps one row per turn (migration 0011) as history.
- **UI:** the agent LLM pickers show “~N turns left” per model; when nothing fits, a non-blocking notice says “Agent allowance for this month is used up · resets <date>”.
- **Amendment (owner, 2026-11-25): DeepSeek is unmetered.** The DeepSeek public LLMs (`deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017`, `UNMETERED_AGENT_LLMS` in `packages/core/pricing/agent.ts`) do not draw on the allowance: no hold or settle; their cost is still recorded in D1 `agent_usage` (`status = 'unmetered'`). They are protected by a per-user abuse limit instead: **300 turns per rolling hour** (`AGENT_ABUSE_LIMIT`, a sliding window kept in the user's `UserHub` DO), beyond which a send returns `429 RATE_LIMITED { retryAfter, model }` (seconds). Classifier calls stay free as before. `GET /api/agent/allowance` (and `agent.allowance`) lists DeepSeek models as `{ id, name, unlimited: true }`; metered models carry `unlimited: false, estTurnUsd, turnsLeft`. The UI shows no turn count for unlimited models.
- **Yearly margin (accepted):** with the yearly discount the worst-case monthly margin may dip below 50% (Starter ≈ 46%). Accepted by the owner; monitored with the monthly margin report (`apps/api/scripts/margin-report.ts`, flags plans below 50%, Team below 60%) and the nightly ledger reconcile. Unmetered DeepSeek cost is part of that report (agent usage USD).

## D-011 — Transfers: one shared queue, uploads direct to R2, resumable both ways (2026-11-25)

- **Uploads go straight from the browser to R2** with presigned S3 `UploadPart` URLs; the Worker never carries upload bytes. Contract (`docs/api.md` → Assets): `POST /api/assets/uploads {filename, contentType, size, fingerprint, projectId?}` → `{assetId, key, uploadId, partSize (8 MiB), partCount, parts:[{n,size,etag}], expiresAt}` — an unexpired upload with the same fingerprint is returned with the parts storage already has; `POST …/:assetId/part-urls {partNumbers}` → `{urls:[{n,url,expiresAt}]}` (~1 h); the client `PUT`s each slice with `credentials: 'omit'` and reads the `ETag` header (bucket CORS exposes it); `GET …/:assetId` lists received parts (S3 `ListParts`) for resume; `POST …/complete` (no body); `DELETE …/:assetId` aborts. The client requests part URLs in batches sized to its in-flight window, refreshes them before expiry and on 403, and falls back to Worker-path part URLs (development only, `direct: false`) with cookies.
- **Fingerprint** = SHA-256 of name, size, lastModified and the first and last 1 MiB (SubtleCrypto). Cheap for 2 GB files; a change only in the middle of a file is not detected (acceptable: the server re-checks part sizes and the total on complete).
- **One queue per origin** in a `SharedWorker` (`apps/web/src/workers/transfers.ts`, engine in `apps/web/src/lib/transfers`), shared by every tab and running while any tab is open. Fallbacks behind a small transport: a dedicated Worker per tab where `SharedWorker` is missing (Chrome Android), else the main thread. In the fallbacks each tab runs its own engine; Web Locks mark which engine owns which persisted item so a reloaded or closed tab's queue is adopted exactly once.
- **Concurrency is configurable** (`lib/transfers/config.ts`): up to 4 files uploading, 4 parts in flight per file, a global cap of 8 parts that adapts by AIMD (+1 after a window of successful parts with stable throughput, halve on 429/5xx/stalls, at most once per 2 s, bounds 2–16); downloads: 3 at once, 3 chunks each, 6 chunks globally. Scheduling is fair: started files keep their slot, free slots go to high priority first (an asset the user waits on, e.g. a prompt reference or a tool input), then smaller files; parts are handed out round-robin by file.
- **Retries**: exponential backoff with equal jitter (500 ms base, 30 s cap, 8 attempts), `Retry-After` honoured; offline time does not spend attempts and the queue resumes on `online`. Pause/resume/cancel per item and globally; cancel aborts the server upload.
- **Resume after reload**: queue records live in IndexedDB (`rolling-transfers`); files ≤ 500 MB are copied into IndexedDB and resume on their own; larger ones show “Pick <name> again to resume” and continue when a re-picked file's fingerprint matches. Uploads are re-synced with `GET …/:assetId` before continuing.
- **Downloads** (`transfers.download(url, {filename, refreshUrl})`, `transfers.fetchBlob(url)`) run through the same queue: 8 MiB `Range` chunks stored in OPFS (IndexedDB fallback), `If-Range` with the ETag so a changed file restarts, deduped across tabs by URL without signature parameters, expired signed URLs (401/403/410) refreshed through the requesting tab's `refreshUrl`. The finished file is handed to the tab: the save picker opens on the click (user activation) and is written at the end, else an object URL with `<a download>`. Finished downloads and `fetchBlob` results share a 1 GB LRU budget.
- **Dev mock**: on localhost, when no API answers `/api/health`, uploads are served by an in-worker mock of the same contract (latency and a simulated link speed). Never used on other hosts.
- **UI**: a transfers dock (count and aggregate progress, opening a panel with per-item progress, speed, ETA and controls); completion and failure toasts only in the tab that started the transfer.

## D-010 — Light mode, following the system (2026-11-25)

- The app supports light and dark themes. Default: follow the system (`prefers-color-scheme`), switching live when the OS changes. Users can override in Settings → Preferences and the header settings popover: System (default) / Light / Dark; stored in prefs.
- Implementation: all colors are tokens (`packages/ui/tokens.css`); `:root` holds dark values, light values apply under `@media (prefers-color-scheme: light)` for `:root:not([data-theme="dark"])` and under `:root[data-theme="light"]`. No hard-coded colors in components except the canvas-drawn timeline, which reads tokens via `getComputedStyle`.
- The approved designs are dark; light mode derives from them (same layout, spacing and accent `#3B82F6`; brand yellow stays logo-only). Editor clip colors get light variants with the same hue roles.
- `theme-color` meta follows the active theme.

## D-009 — Model menus: curated lists, public agent LLMs, Auto via classifier (2026-11-25)

- **Pickers show curated lists.** Each catalog model has a placement: `featured` (main list), `more` (behind “More models”), or `tool` (only in the tool that needs it). Face/head swap (image and video), motion transfer, LoRA and utilities like face detection never appear in video or image pickers. Picker panels cap their height to the viewport and scroll inside.
- **Public agent LLMs** (`packages/core/models/chat.ts`), shown by name; clients only see public ids, never gateway ids:
  - DeepSeek V4.1 Flash (default) → cheapest of `deepseek-v4.1-flash` / `-us` at live token prices.
  - DeepSeek V4.1 Flash 1017 → cheapest of `-1017` / `-1017-us`; mature turns (D-005) route to `deepseek-v4.1-flash-cyber`.
  - Claude Sonnet 5.5, Claude Haiku 5.5, Claude Opus 5.5, GPT-6 Astra, GPT-6.1 Sol, Grok 4.6, GLM 5.3 → their gateway models.
  - An entry is listed only while one of its gateway models is in the synced catalog.
- **Wan 3.0 is served through Berry.** `lumina/berry-1.0*` is the same model, capabilities and price as `alibaba/wan3.0*`; users see “Wan 3.0 / Turbo / Pro / Pro Turbo” (Wan icon) and calls go to the Berry ids; the `alibaba/wan3.0*` ids are hidden.
- **Auto model selection uses an LLM classifier.** For generation runs with model “Auto”, the backend asks DeepSeek V4.1 Flash (cheapest route) to pick a model from the candidates that satisfy the request’s capabilities, the plan’s resolution cap (D-006) and mature routing (D-005), given the prompt, references, mode and length. Output is a Zod-validated model id from that candidate list; anything else, a timeout (4 s; measured DeepSeek latency 1–2.3 s) or an error falls back to the deterministic `pickAuto` (cheapest capable model). The classifier is free to the user and runs before the quote, so the quote shows the chosen model.
- Premium agent LLMs are metered by the monthly agent allowance: see D-012.

## D-008 — Media is served from a media domain, not the API (2026-11-25)

In production, images and video never stream through the API Worker.

- **Public library** (non-mature PoseWear items): a separate R2 bucket `rolling-public-<env>` holding only non-mature public objects, attached to a custom domain (e.g. `media.<product-domain>`) and served directly by the Cloudflare CDN with long immutable caching. The importer writes there (`copy-to-r2.ts` without `--include-mature`, `R2_BUCKET=rolling-public-<env>`). Mature public items stay only in the private bucket.
- **Private media** (uploads, generated results, exports, mature items): the private bucket `rolling-media-<env>` is never public. Clients get short-lived signed URLs on the media domain (a small media Worker on that hostname verifies an HMAC token: key, expiry, workspace), so the API only issues URLs and never carries bytes. Mature results are only signed for users allowed to see them (D-005).
- **Config:** `PUBLIC_MEDIA_BASE_URL` (Worker var) is the public bucket's origin; API responses build image URLs from it. Empty means fallback to the Worker route `/api/media/...`, used only in local dev and staging until the product domain exists.
- Open: the product domain (D-001 open decision) — the media hostname is created with it.

## D-007 — The agent is members-only; margin assumptions (2026-11-25)

- **Non-members cannot use the agent.** This replaces PRD rule 1’s “plan with the agent for free”. Without an active plan a user can sign up, browse, open templates’ previews and the public library, and type a brief; sending it to the agent (Home Agent mode, canvas agent panel, editor “Ask for an edit”, Simple-mode field filling in tools) opens Paywall `variant=join` and keeps the brief so it resumes after checkout. The API enforces it: agent routes and the agent WebSocket messages return `NO_PLAN` for workspaces without an active subscription.
- Agent turns stay free for members (they do not spend credits); they draw on the plan's monthly agent allowance (D-012, which replaced the daily turn limits).
- **Margin assumptions** (owner): the Hyperouter 5.5% top-up fee is not counted, and payment-channel risk (e.g. high-risk processors for adult content) is not modelled for now. The 3× markup applies to every model, mature ones included.

## D-006 — Pricing: credits are the product, plans are the entry ticket (2026-11-25)

Owner decisions: gross margin ≥ 50%; revenue comes mainly from top-ups; plans exist to unlock membership (which is also the age gate, D-005) and are tiered precisely by perks. The Hyperouter 5.5% top-up fee is ignored. Values live in `packages/core/pricing/config.ts`; tests enforce the margin floor and the caps.

- **Credit unit:** 1 credit = $0.01 retail. `credits = ceil(gatewayUsd × 3.0 ÷ 0.01)` (3× markup on live list price, per resolution and length). Example: Seedance 2.5 720p 5 s = 347 credits.
- **Plans — Starter, Plus, Pro** (ids `starter`, `plus`, `pro`; D1 migration 0003 renamed the old `pro`/`studio`):

| Plan | Monthly | Yearly (−20%) | Credits/month | Top-up bonus | Jobs at once | Max video | Max image | Voice clone | Seats |
|---|---|---|---|---|---|---|---|---|---|
| Starter | $5 | $48 | 200 | +0% | 2 | 720p | 2K | no | 1 |
| Plus | $15 | $144 | 800 | +5% | 5 | 1080p | 2K | yes | 1 |
| Pro | $49 | $470 | 2,500 | +10% | 10 | 4K | 4K | yes | 1 (was 10; seats moved to Team, D-013) |

- **Resolution caps** are enforced by `planAllowsResolution(plan, kind, resolution)` on every quote and run (video and avatar runs use the video cap). Ranks use the short side (768p > 720p, so MiniMax H3 at 768p needs Plus); unknown labels are refused. The UI shows locked resolutions with the lowest plan that unlocks them (`lowestPlanFor`).
- **Top-ups (members only, never expire): any amount from $10 to $10,000** in whole cents. Base credits = amount ÷ $0.01, plus a bonus by amount tier — $10+ 0%, $25+ 4%, $50+ 10%, $100+ 15% — plus the plan bonus above (additive, max 25%). Suggested chips: $10, $25, $50, $100, $250.
- **Margin floor (all credits used, after card fees ~4.65% + $0.30 and 2% infra):** top-ups ≥ 50.0% at every amount and plan (worst case: Pro member, ≥ $100); plans 70–76%. Real usage below 100% raises it.
- **Confirm threshold** default 300 credits (≈ $3), the PRD's “20 credits” rescaled. **Auto top-up:** below 200 credits, top up the $10 minimum.
- Supersedes the PRD's plan names (Starter/Pro/Studio), plan credits, prices, yearly discount, credit packs and per-model credit prices. ~~The PRD's “Teams (Studio)” rule now applies to Pro.~~ Seats moved to the Team plan (D-013); every personal plan has 1 seat.

## D-005 — Adult (18+) content is allowed (2026-11-25)

The platform allows 18+ creation for paying members. This replaces the PRD line “compliance/moderation work beyond what providers enforce” being out of scope.

- **Access = paid membership.** No date-of-birth or separate age verification. Paying (an active plan via Stripe) is treated as the age gate: 18+ generation is available only to workspaces with an active subscription. Non-members and lapsed members get `moderation: "auto"` routing only. A per-user preference `prefs.matureContent` (default off) controls whether mature models and outputs are shown — it is a visibility preference, not verification. Workspaces can disable it for all members (`workspaces.matureAllowed`).
- **Regional risk (open).** Some jurisdictions (e.g. UK Online Safety Act, several US states) require “highly effective” age assurance for adult content; card payment may not satisfy it everywhere (debit/prepaid cards). Revisit per launch region; keep a `AgeAssurance` hook point in the run path so a region-specific check can be added without redesign.
- **Hard limits, never configurable:** no sexual content involving minors or anyone who appears to be a minor; no sexual or intimate content depicting a real, identifiable person (uploaded face photos, celebrity names) — real-person references are allowed only for non-sexual content. These run as a pre-submit check on prompts and references (`packages/core/safety`) and as a post-generation check on outputs; violations block the run, release the hold, and are logged for review.
- **Provider routing.** Hyperouter `moderation: "low"` is enabled on the account (2026-11-25). Mature runs go only to models flagged `mature: true` (the `lumina/*-spicy` family and any model whose listing supports the `moderation` parameter) in `packages/core/models/capabilities`, with Hyperouter `moderation: "low"`; everything else uses `moderation: "auto"`. Provider rejections (`content_rejected`, `vendor_rejected`) release the hold like any failure.
- **Identity-driven models** (face/head swap, photo-driven i2v and lip-sync) are never used for mature runs with an uploaded photo. Mature photo-driven runs are allowed only when every input image is a platform asset (generated on Rolling, a saved Character, or a public-library item); uploaded photos are rejected for mature runs. Face/head swap is never mature.
- **Visibility.** Mature outputs are blurred in lists until clicked, never shown on public share links, profiles, templates or the public library, and never used as thumbnails in shared surfaces.
- **Implementation (2026-11-25).** `packages/core/safety` + `apps/api/src/safety`: deterministic multilingual rules (minor-coded × sexual terms, ages under 18, identity/swap rule) run at quote time and first in every check; then DeepSeek V4.1 Flash as a strict-JSON (Zod) text classifier for the hard limits — minors, real identifiable people, plus non-consensual sexual content, real-world extreme violence/gore, violent-extremist propaganda and self-harm instructions; on mature runs the cheapest vision-capable chat model (DeepSeek V4.1 Flash, Claude Haiku 5.5 / GPT-6.1 Sol as gateway fallbacks) rates image references and `lumina/face-detect` checks uploaded photographs for real faces. `prepare` pre-checks, `store` post-checks outputs (video via the poster frame) and deletes blocked objects; blocks release the hold. Fail closed on mature runs (`SAFETY_UNAVAILABLE`). Every output and upload gets a content rating (`safe|suggestive|explicit`) that drives visibility (`assets.mature`), not the run's flag. Explicit non-mature prompts get `MATURE_REQUIRED` instead of mature routing. Events in `safety_events` + Analytics Engine; ≥ 3 hard-limit blocks in 24 h flag the workspace and pause its mature runs until review. The agent checks briefs and proposals through `SafetyGate`. Live check: 32/32 benign and boundary prompts correct; ~$0.00006 per text check, ~$0.00006 per vision batch, $0.0013 per face detection.
- **Payments risk (open).** Stripe’s restricted-business list covers adult content. Confirm with Stripe before launch; keep the payment layer behind `packages/core/billing/PaymentProvider` so a second processor can be added. Until confirmed, no Stripe-facing copy mentions adult content.

## D-004 — PoseWear content is the public library (2026-11-25)

Source: https://posewear.pages.dev/ (data index at `/assets/poses.<hash>.json`, images on `pwimg.0vo.pro`). Categories and counts at import time:

| Group | Category (zh) | Key | Count | License |
|---|---|---|---|---|
| Pose | 姿势 | `pose` | 288 | First-party |
| Pose | 深度姿势 | `pose_depth` | 288 | First-party |
| Character look | 人像 | `portrait` | 1499 | CC0 |
| Character look | 表情 | `expression` | 95 | MIT |
| Character look | 发型 | `hairstyle` | 122 | CC0 |
| Wardrobe | 服装 | `outfit` | 1407 | First-party |
| Wardrobe | 动画服装 | `outfit_anime` | 1760 | First-party |
| Wardrobe | 历代服饰 | `outfit_historical` | 57 | CC0 |
| Scene & props | 场景 | `scene` | 64 | CC0 |
| Scene & props | 光影 | `lighting` | 50 | CC0 |
| Scene & props | 道具 | `prop` | 32 | CC0 |
| Scene & props | 家具 | `furniture` | 41 | CC0 |

- An import script (`packages/db/scripts/import-posewear.ts`) reads the JSON index, copies images into R2 (`public/<category>/<id>/…`), and upserts `public_items` rows (+ `assets` with source `public`, + `asset_search` FTS) in D1 with category, sub-category, tags, prompt text, license and source URL. It is idempotent and re-runnable.
- **Rights.** The owner holds authorization from the upstream author (@giaaibusi) for the pose, depth-pose, outfit and anime-outfit galleries (confirmed 2026-11-25). CharaDB-hosted images (all hairstyles, 440 anime outfits) are NOT covered — CharaDB allows tags/prompts only — so they are excluded from R2 (`--exclude-attribution charadb`) until we have permission or regenerate them; their metadata may still be used.
- **PoseWear is our own property** (confirmed by the owner, 2026-11-25). Items the PRD marked “Rights reserved” (poses, depth poses, outfits, anime outfits) are first-party: license value `first-party`, no warning label, no replacement needed before launch. This supersedes PRD rule 9’s “replace before paid launch”. CC0 and MIT items keep their labels.
- Items are referenceable through `@` (Public library tab) and usable as references in generation: poses and depth poses as pose/control references, outfits/hairstyles/expressions/portraits as image references plus their prompt text.

## D-003 — API style: REST commands, WebSocket-first realtime, GraphQL reads (2026-11-25)

- **REST** (`/api/*`, Hono + Zod) for commands and anything with side effects: auth, billing, checkout, runs (quote/start/cancel), uploads, proposal apply/discard, webhooks. The REST table in `api.md` stays the command contract.
- **WebSocket** is the default channel for live state. One socket per open project (`/api/projects/:id/ws` → ProjectRoom) carries graph and timeline patches in both directions, job progress, node versions, proposals, agent token streams and presence. One user socket (`/api/ws` → a per-user `UserHub` Durable Object) carries credits changes, Activity updates, notifications and Home agent streams. Agent message streaming uses the socket, not SSE. Every WS message is a Zod-validated envelope `{ type, id, payload }`; client→server patches get `ack { id, revision }` or `conflict { id, snapshot }`.
- **GraphQL** (`/api/graphql`, GraphQL Yoga on Workers) for read-heavy, nested queries: projects list, assets and `@` picker search, public library, templates, Activity with filters, ledger. Read-only (no mutations), persisted queries in production, depth/complexity limits, same auth context as REST.

## D-002 — Hyperouter is the single model gateway (2026-11-25)

All LLM and generation calls go through Hyperouter (`https://api.hyperouter.app/v1`, `Authorization: Bearer sk-hr-v1-…`, docs https://hyperouter.app/docs). One provider adapter: `packages/core/models/providers/hyperouter/*`.

- **Agent LLM:** `deepseek/deepseek-v4.1-flash` via `/v1/chat/completions` (OpenAI-compatible, tools, SSE). `models` fallback list allowed.
- **Video:** `POST /v1/videos` (always async) → poll `GET /v1/videos/{id}` or webhook `video.completed|failed` → `GET /v1/videos/{id}/content`.
- **Image:** `POST /v1/images/generations|edits` with `Prefer: respond-async` → `GET /v1/generations/{id}` or webhook `image.completed|failed`.
- **Webhooks:** Standard Webhooks signing (`webhook-id`, `webhook-timestamp`, `webhook-signature` = `v1,` + base64 HMAC-SHA256 of `id.timestamp.body`, secret `whsec_…`). Payload carries only `data.id`; fetch the object after verifying. Dedupe on `webhook-id`.
- **Idempotency:** `Idempotency-Key` on every paid create (our job id); 30-minute window.
- Output URLs expire (images 24 h signed, video content 15 min); the `store` step copies to R2 immediately.

Launch model mapping (PRD → Hyperouter):

| PRD model | Hyperouter id | Status |
|---|---|---|
| Seedance 2.5 | `bytedance/seedance-2.5` | available (default video) |
| MiniMax H3 | `minimax/minimax-h3` | available |
| Wan 3.0 | `alibaba/wan3.0` | available |
| Wan 2.2 (cheap/fast) | `bytedance/seedance-2.0-mini` or `-fast` | substitute, confirm |
| Seedream 5.0 Pro | — | not listed; `bytedance/seedream-5.0-lite` is the default until available |
| Seedream 5.0 Lite | `bytedance/seedream-5.0-lite` / `-flash` | available |
| Wan 2.7 Image | `qwen/qwen-image-2.0` | substitute, confirm |
| Avatar lip-sync | `lumina/wan2.7-i2v-spicy` (photo + audio_url) | candidate |
| TTS, voice clone | — | **open**: owner is sourcing a provider |

**Model catalog is driven by the live listing** (owner decision, 2026-11-25): `GET /v1/models` is the source of truth for available models, durations, resolutions, reference limits and USD prices. A scheduled sync stores it in D1; the model picker, Auto selection and quotes read the synced catalog. PRD limits (e.g. 30s Seedance, MiniMax audio) are superseded by what the listing says. Our own overlay adds product fields only (display name, tags, default flags, `mature`, `requiresIdentitySafety`, hidden).

**Credits follow live cost**: `credits = ceil(usdCost(model, seconds, resolution, audio, refs) × markup ÷ usdPerCredit)`, with `markup` and `usdPerCredit` placeholders in `packages/core/pricing/config.ts`. This gives per-resolution prices automatically.

## D-001 — Language (2026-11-25)

All code, comments, commit messages, docs written for the repo, and identifiers are in English. Conversation with the user is in Chinese. UI copy source is English (`messages/en.json`).
