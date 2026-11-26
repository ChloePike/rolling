# API

JSON over HTTPS under `/api`, served by the Hono Worker. Auth by session cookie. Every write takes and returns a `revision` where noted; a stale revision returns `409 CONFLICT` with the current state. Errors: `{ "error": { "code": "…", "message": "…", "data": {} } }`.

Payment-related error codes the UI must handle:
- `NO_PLAN` → open Paywall `variant=join`, keep the pending action.
- `INSUFFICIENT_CREDITS` (`data: { needed, balance }`) → Paywall `variant=credits`.
- `QUOTE_EXPIRED` → re-quote and show the new total.
- `MEMBER_LIMIT_REACHED` → tell the user their team limit for the month is used.
- `CONCURRENCY_LIMIT` (`data: { limit, active, requested }`) → too many jobs running for the plan; wait or upgrade.

## Auth (M1)

Better Auth on D1, mounted at `/api/auth/*`. The session cookie is `__Secure-rolling.session_token` on https (`rolling.session_token` on `http://localhost`): `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days, sliding (refreshed once a day of use; the refreshed cookie comes back on any `/api` response). Sessions are rows in D1 (`sessions`). Better Auth checks `Origin` on cookie-bearing POSTs: send requests from the app origin (`PUBLIC_APP_URL`, or one of the comma-separated `EXTRA_TRUSTED_ORIGINS`). Errors use the envelope; Better Auth's own code is in `data.authCode`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/providers` | `{ emailCode: true, google: { clientId, loginUri } \| false }`. Google (D-017) is offered when `GOOGLE_CLIENT_ID` is set (no secret); `clientId` is public, `loginUri` is `<origin>/api/auth/google/credential` for the origin the request came to (PUBLIC_APP_URL or one of EXTRA_TRUSTED_ORIGINS) |
| GET | `/api/auth/nonce?redirect=` | `{ nonce, expiresIn: 300 }`, `no-store`. A random single-use nonce for Google Identity Services (`nonce`); only its SHA-256 is stored (D1 `verifications`, `google-nonce:<hash>`, 5 min) with `redirect` (an app path) for the redirect fallback. 100/min per IP. `404` when Google is not configured |
| POST | `/api/auth/email-otp/send-verification-otp` | `{ email, type: "sign-in" }` → `{ success: true }`. Emails a 6-digit code valid 10 minutes (new and existing users alike). `429 RATE_LIMITED` with `data.retryAfter` (seconds): 30 s resend cooldown per address; 5 requests per minute per email + IP (`retryAfter: 60`) |
| POST | `/api/auth/sign-in/email-otp` | `{ email, otp }` → `{ token, user }` and the session cookie. Creates the user on first sign-in (sign-up: personal workspace, owner membership, prefs from `Accept-Language`). Errors: `400 INVALID_CODE`, `400 CODE_EXPIRED`, `429 TOO_MANY_ATTEMPTS` (5 wrong tries; ask for a new code), `429 RATE_LIMITED` (5 tries per minute per email + IP), `400 VALIDATION_FAILED` (code not 6 digits) |
| POST | `/api/auth/sign-in/social` | Google ID-token sign-in (One Tap): `{ provider: "google", idToken: { token, nonce }, callbackURL? }` → `{ user, redirectTo }` and the session cookie (creates the user and personal workspace on first sign-in; links to an existing account with the same verified email). Server checks: signature against Google's JWKS, `aud` = `GOOGLE_CLIENT_ID`, `iss` `accounts.google.com`, `exp`/`iat` (max age 1 h), the token's `nonce` claim equals `nonce`, the nonce is live and unused (consumed here), `email_verified`. `redirectTo` = `callbackURL` or the nonce's `redirect` or `/`. Errors: `401 UNAUTHENTICATED` `data.reason: "INVALID_TOKEN" \| "NONCE"` (Better Auth's code in `data.authCode`), `403 FORBIDDEN data.reason: "EMAIL_NOT_VERIFIED"`, `400 VALIDATION_FAILED` (no `idToken`: the OAuth code flow is not offered) |
| POST | `/api/auth/google/access-token` | Google sign-in from our own button (D-017): the GIS OAuth2 token client's popup (`scope: openid email profile`, no client secret) returns an access token; body `{ accessToken, redirect?, intent?: "signin" \| "link" }` (strict: profile fields are refused, never trusted) → `{ user, redirectTo }` and the session cookie (`redirectTo` = `redirect` when it is a safe app path, else `/`); `intent: "link"` (signed in, Settings) → `{ linked: true }`, no new session. Server checks: `GET https://oauth2.googleapis.com/tokeninfo?access_token=` (`aud` and `azp` = `GOOGLE_CLIENT_ID`, `exp` in the future, scope includes `email`), then `GET https://openidconnect.googleapis.com/v1/userinfo` with the token (`sub` must match tokeninfo; `email`, `email_verified` required, `name`, `picture`). Creates or links the user through Better Auth's `handleOAuthUserInfo` (same account-linking rules as the ID-token sign-in); the access token is not stored. Better Auth's Origin check (cookie-bearing POSTs) and Fetch-Metadata CSRF check apply; 100/min per IP. Errors: `401 UNAUTHENTICATED data.reason: "INVALID_TOKEN" \| "SCOPE"`, `403 FORBIDDEN data.reason: "EMAIL_NOT_VERIFIED"`, `409 CONFLICT data.reason: "ACCOUNT_IN_USE"` (link: the Google account belongs to another user), `401` (link without a session), `403` (untrusted Origin), `400 VALIDATION_FAILED`, `404` when Google is not configured |
| POST | `/api/auth/google/credential` | Where Google posts a credential (form, cross-site; no Origin check, a double-submit token instead). GIS redirect mode: `credential` + `g_csrf_token` (must equal the `g_csrf_token` cookie). `/google/start`: `id_token` + `state` (must equal the `rolling.g_state` cookie; nonce required). Same token checks as above (nonce when present). Success → `303` to the nonce's `redirect` (default `/`) with the session cookie; for `intent=link`, links Google to that user and `303`s to `/settings/account`. Failure → `303 /login?error=<code>` (`csrf`, `invalid_token`, `nonce`, `email_not_verified`, `access_denied`, `account_in_use`, `unavailable`) |
| GET | `/api/auth/google/start?redirect=&intent=link` | Script-free fallback (GIS blocked or not loaded yet, popup blocked): issues a nonce and state (cookie `rolling.g_state`, `SameSite=None`, 5 min) and `302`s to Google's OIDC endpoint (`response_type=id_token`, `response_mode=form_post`, `redirect_uri` = `<origin>/api/auth/google/credential`). `intent=link` (Settings → Sign-in methods) needs a session |
| * | `/api/auth/callback/*`, `/api/auth/link-social`, `/api/auth/oauth2/*` | Closed (`404`): no OAuth code flow without a client secret (D-017) |
| GET | `/api/auth/get-session` | Better Auth session read (`{ session, user }` or `null`); prefer `/api/me` |
| POST | `/api/auth/logout` | Ends the session (D1 row deleted, cookie cleared) → `{ ok: true }`; always 200 |
| POST | `/api/auth/email-otp/request-email-change` | Signed in. `{ newEmail }` → `{ success: true }`; emails a 6-digit code (10 min) to the **new** address (nothing is sent when the address already has an account). `429 RATE_LIMITED` (30 s cooldown per address; 5 per minute per address + IP) |
| POST | `/api/auth/email-otp/change-email` | Signed in. `{ newEmail, otp }` → `{ success: true }`; the account's email becomes `newEmail` (verified) and the session cookie is refreshed. `400 INVALID_CODE` / `CODE_EXPIRED`, `429 TOO_MANY_ATTEMPTS`, `409 CONFLICT data.reason: EMAIL_IN_USE` |
| * | `/api/auth/delete-user`, `/api/auth/delete-user/*` | Closed (`404`): account deletion goes through `POST /api/me/delete` |

Signed-out callers of member routes get `401 UNAUTHENTICATED`. The current workspace is the `x-workspace-id` header (WebSocket upgrades: `?workspaceId=`), validated against membership (`403 FORBIDDEN`, malformed `400 BAD_REQUEST`); without it, the user's personal workspace. Every `/api` route sees the same context `{ userId, workspaceId, role, plan, isMember, matureAllowed, prefs, memberships }` (REST, GraphQL context `auth`, WebSockets). In `ENVIRONMENT=development` only (local dev, tests), the `x-dev-user: <id>` header (or `?devUser=`) stands in for a session.

## Account
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | See shape below. `private, no-store` |
| PATCH | `/api/me/prefs` | Any subset of `{ language, currency, creationMode, defaultRatio, defaultModel, confirmThreshold, notifications, theme, matureContent }` → `{ prefs, matureAllowed }`. Unknown keys or an empty body → `400 VALIDATION_FAILED`. `matureContent: true` without an active plan → `402 NO_PLAN`. Pushes `prefs.changed { prefs }` to the user's sockets |
| PATCH | `/api/me/profile` | Any subset of `{ name, handle, bio, avatarAssetId }` → `{ profile: { name, handle, bio, image } }`. `name` 1–80 chars; `handle` 3–30 of `a-z 0-9 _ .` (a leading `@` is dropped, stored lowercase); `bio` ≤ 160 (empty clears); unknown keys or an empty body → `400 VALIDATION_FAILED`. A handle taken by someone else (case-insensitive) or reserved (`admin`, `settings`, `api`, …) → `409 HANDLE_TAKEN`. `avatarAssetId`: an image asset the caller uploaded (assets upload pipeline) → rated now if unrated (D-005); anything but `safe` → `422 AVATAR_REJECTED data: { reason: "rating", rating }` (or `reason: "blocked"`), classifier down → `503 SAFETY_UNAVAILABLE`, someone else's asset → `404`; a 256 px WebP is stored under the personal workspace and `users.image` becomes `/api/media/avatar/<userId>?v=<version>`. `avatarAssetId: null` removes it |
| POST | `/api/me/delete/send-code` | Emails a 6-digit code (10 min) to the account's address → `{ sent: true, email, expiresInMinutes, workspacesToDelete }`. `409 OWNER_OF_TEAM data: { workspaces: [{ id, name, members }] }` when the user owns a Team workspace with other members and no other owner (transfer ownership first). `429 RATE_LIMITED` (30 s cooldown) |
| POST | `/api/me/delete` | `{ code }` → `{ ok: true }` and the session cookie cleared. Errors: `400 INVALID_CODE` (`data.attemptsLeft`), `400 CODE_EXPIRED`, `429 TOO_MANY_ATTEMPTS` (5 wrong codes; ask for a new one), `409 OWNER_OF_TEAM`, `502 INTERNAL` (Stripe cancel failed; nothing deleted). Effects below |
| POST | `/api/account/export` | `{}` → `202 { export: DataExport, email, linkTtlDays: 7 }`; starts `DataExportWorkflow`, which emails a signed download link (template `data-export-ready`, 7 days). One per 24 h per user (failed exports do not count): `429 RATE_LIMITED data: { retryAfter, nextAvailableAt }` |
| GET | `/api/account/export` | → `{ export: DataExport \| null }` (latest). `DataExport = { id: "dex_…", status: "queued" \| "running" \| "done" \| "failed" \| "expired", createdAt, finishedAt, expiresAt, nextAvailableAt }` |

`GET /api/me`:

```json
{
  "user": { "id": "usr_…", "email": "ada@example.com", "name": "", "image": null, "emailVerified": true },
  "workspace": { "id": "ws_…", "name": "Personal", "kind": "personal", "matureAllowed": true },
  "role": "owner",
  "monthlyCreditLimit": null,
  "workspaces": [{ "id": "ws_…", "name": "Personal", "kind": "personal", "role": "owner", "plan": null }],
  "prefs": {
    "language": "en", "currency": "USD", "creationMode": "simple", "defaultRatio": "9:16", "defaultModel": "auto",
    "confirmThreshold": 300, "notifications": { "done": true, "low": true, "renewal": true, "product": false },
    "theme": "system", "matureContent": false
  },
  "plan": null,
  "isMember": false,
  "matureAllowed": false,
  "balance": { "plan": 0, "purchased": 0, "held": 0, "planExpiresAt": null }
}
```

- `plan` when the workspace has an active plan (subscription `active`/`trialing`, period not over): `{ id: "starter"|"plus"|"pro"|"team", label, interval: "month"|"year", status, currentPeriodEnd, cancelAtPeriodEnd, perks: { monthlyCredits, topUpBonus, concurrentJobs, maxVideoResolution, maxImageResolution, voiceCloning, seats } }` (perks from `PLANS`, D-006; Team `monthlyCredits`, `concurrentJobs` and `seats` follow purchased seats, D-013).
- `user.handle` (null until chosen) and `user.bio` (null when empty) drive the public profile `/u/:handle`; `user.image` is the avatar URL (`/api/media/avatar/…`, or a Google photo).
- `isMember` = active plan (D-007). `matureAllowed` = member && `prefs.matureContent` && `workspace.matureAllowed` (D-005).
- `balance` from `CreditAccount.balance()`; zeros until that RPC is available.
- Prefs values: `language` ∈ en, ja, zh-TW, zh-HK, ko, id, th, vi, es, pt-BR, de, fr; `currency` ∈ USD, EUR, GBP, JPY, TWD, HKD, KRW, IDR, THB, VND, BRL; `creationMode` ∈ simple, advanced; `defaultRatio` ∈ 16:9, 9:16, 1:1, 4:5, 21:9; `theme` ∈ system, light, dark (D-010); `confirmThreshold` integer 0–100000 credits (0 = always confirm); `notifications` partial `{ done, low, renewal, product }` booleans, merged. Sign-up defaults: language and currency from `Accept-Language` (unsupported → en / USD), the rest as shown above.

**Public profiles** (no session needed):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/profiles/:handle` | Case-insensitive → `{ userId, name, handle, bio, avatarUrl, works: [{ shareId, title, url, coverUrl, kind: "image"\|"video", durationSec, createdAt }], templates: [{ id, title, category, coverUrl, uses }], isYou }`; `404` unknown. `works` = the user's active share links with `showOnProfile` whose cover asset is rated `safe` and not mature (re-checked on every read, D-005; covers without a rating are not listed); `templates` = global templates (`workspace_id` NULL) with `created_by` = the user and a safe preview. `coverUrl`s are signed for 1 h |
| GET | `/api/media/avatar/:userId` | `302` to a signed URL (1 h) of the avatar image; `404` when none is set or its source has been rated mature since. `Cache-Control: public, max-age=300`. Never carries bytes (D-008) |

**Account deletion** (`POST /api/me/delete`) runs Better Auth `deleteUser` with a one-time token; its `beforeDelete` hook (`apps/api/src/auth/deleteAccount.ts`): every owned workspace without another owner is removed — its live Stripe subscription is set to `cancel_at_period_end` (idempotency key `account-delete:<subId>`), the row is soft-deleted (`workspaces.deleted_at`, kept for webhooks and ledger history), members, pending invites, projects (share links revoked), assets, uploads, characters, voices, workspace templates, exports and agent threads are deleted, run prompts (`runs.request`) are cleared and `ws/<id>/` is queued in `r2_cleanup` (the 5-minute sweep cron deletes the objects); Team workspaces with another owner are just left, and a Team with other members and no other owner refuses with `409 OWNER_OF_TEAM`. Then memberships elsewhere and the user's agent threads anywhere are removed; `assets.created_by`, `share_links.created_by` (and `show_on_profile`), `templates.created_by`, `characters.created_by` and `feedback.user_id` are set to NULL; retained records carry the user's **tombstone** (`usr_deleted_<hash>`, `@rolling/core/privacy` `tombstoneUserId`) instead of the id: `ledger_lines.user_id`, `safety_events.user_id`, `agent_usage.user_id` and `created_by` of `runs`, `jobs`, `quotes`, `exports` and `projects` left in shared workspaces. Prefs and the avatar go, and Better Auth deletes the user, linked accounts and every session. Durable Object storage is handled by a durable job (`apps/api/src/auth/deletionJob.ts`, D1 `account_deletions` + `account_deletion_items`, `AccountDeletionWorkflow`, one step per 25 items, retried; the daily cron restarts unfinished jobs): `ProjectRoom.purge()` (deleteAll, alarm cleared, sockets closed 4410) for projects of removed workspaces, `pseudonymizeUser()` for projects in workspaces the user leaves, `AgentSession.purge()` for every thread above, `UserHub.purge()`, and `CreditAccount.pseudonymizeUser()` (ledger, holds, member usage, agent holds, idempotency results keep their rows under the tombstone). The job id derives from the tombstone and every step is idempotent; when it finishes, the raw user id is replaced by the tombstone in `account_deletions`.

**Retention purge** (daily `17 3 * * *` cron, `apps/api/src/ops/retention.ts`, periods in `packages/core/src/privacy.ts`): `safety_events` older than `SAFETY_LOG_RETENTION_DAYS` (365) deleted and `excerpt` set to NULL after `SAFETY_EXCERPT_RETENTION_DAYS` (90); `agent_usage` older than `AGENT_USAGE_RETENTION_DAYS` (400) deleted; data export bundles past 7 days removed from R2 (`status: expired`).

**Feedback:**

| Method | Path | Notes |
|---|---|---|
| POST | `/api/feedback` | Signed in. `{ message (1–5000), kind: "bug"\|"idea"\|"other" (default other), page? (≤ 500), includeDiagnostics? (false) }` → `201 { id, received: true }`. Stored in D1 `feedback`; diagnostics are collected server-side (user agent, country, workspace, role, plan, language, time). Emailed to `FEEDBACK_TO` when set. `429 RATE_LIMITED` after 10 per hour per user |

WebSocket `/api/ws` (UserHub) is the global socket (D-014): one per browser, multiplexed by channel — see **Global WebSocket** below. It needs a session (refused with close code `4401` otherwise). User-channel messages: `hello`, `prefs.changed { prefs }`, `credits.changed`, `activity.updated`, `agent.allowance`, `notification`.

### WebSocket close codes (refused upgrades)

Browsers cannot read the status or body of a failed upgrade, so every WebSocket route (`/api/ws`, `/api/projects/:id/ws`, `/api/agent/threads/:id/ws`) **accepts** a refused upgrade, sends one `error { code, message, data }` envelope and closes at once with `4000 + HTTP status`:

| Close code | Meaning | `error.code` |
|---|---|---|
| `4401` | Not signed in (no/expired session) | `UNAUTHENTICATED` |
| `4402` | No active plan (agent thread socket, D-007) | `NO_PLAN` |
| `4403` | Not a member of the `?workspaceId=` workspace, or role too low | `FORBIDDEN` |
| `4404` | Project or thread missing or in another workspace | `NOT_FOUND` |
| `4410` | Project deleted while connected (project socket) | `PROJECT_DELETED` |

A request without `Upgrade: websocket` still gets HTTP `426`. Clients should not auto-reconnect after `4401`/`4403`/`4404` (sign in, switch workspace or leave the project first).

### Global WebSocket (`/api/ws`, D-014)

One connection per browser, held by the client's SharedWorker; the user's `UserHub` DO is the gateway (hibernation API). Envelope `{ type, id, payload, channel?, projectId?, seq? }`: server messages carry `channel: 'user' | 'project'`; project messages also carry `projectId` and, for replayable events, `seq` (the project's event cursor). Replies carry the client message `id`.

| Client → gateway | Payload | Reply (same `id`) |
|---|---|---|
| `subscribe` | `{ channel: 'project', projectId, lastRevision?, lastSeq? }` | `subscribed { projectId, revision, seq, canEdit, snapshot? , events? }` · `error { projectId, code: NOT_FOUND }` (not a member of the project's workspace, or missing) |
| `unsubscribe` | `{ projectId }` | `unsubscribed { projectId }` |
| `patch` | `{ projectId, baseRevision, ops }` | `ack { revision, idMap, statuses }` · `conflict { snapshot }` · `error { projectId, code, message, data? }` |
| `undo` / `redo` | `{ projectId }` | `ack { revision, ops, statuses }` · `error { projectId, code: NOTHING_TO_UNDO \| NOTHING_TO_REDO \| FORBIDDEN }` |
| `timeline.patch` | `{ canvasId, baseRevision, ops }` | `ack { revision, canvasId }` · `conflict { timeline }` · `error { projectId, code: TIMELINE_INVALID }` |
| `snapshot` | `{ projectId }` | `snapshot` (as on the project socket) |
| `ping` | `null` | `pong` (a raw `ping` text frame gets `pong` without waking the hub) |

- **Auth:** the connection needs a session (close codes above). Each `subscribe` checks membership of the project's workspace in D1 (viewers read, editors+ write; membership is re-read before writes when the last check is older than 60 s). Per-subscription failures are `error { projectId, code }` and leave the connection open; commands for a project the socket has not subscribed → `error { code: NOT_SUBSCRIBED }`.
- **Project channel:** after `subscribe`, the socket receives every project event: `graph.patched`, `node.version`, `job.queued`, `job.progress`, `job.done`, `job.failed`, `timeline.patched`, `proposal.created`/`proposal.updated`, `agent.*` of canvas/editor threads, `credits.changed`, and `error { projectId, code: PROJECT_DELETED }` (subscription ended). The connection that sent a `patch`/`undo`/`redo` gets the `ack` and not its own `graph.patched`; the user's other sockets and other users get `graph.patched`.
- **User channel:** `credits.changed`, `prefs.changed`, `activity.updated`, `agent.allowance`, `notification` and Home/tool agent streams go to all of the user's sockets.
- **Catch-up:** ProjectRoom keeps a ring of the newest 500 replayable events (everything except `job.progress`, `agent.delta`, `credits.changed`, `error`). On `subscribe` with `lastSeq` still in the ring, `events: [{ seq, type, payload }]` holds the gap; with only `lastRevision`, the events after that revision's `graph.patched` (a few already-applied events may repeat; they are idempotent); otherwise `snapshot`. Events can arrive before `subscribed`: buffer project events until it arrives, then apply the snapshot or `events`, then the buffered ones with `seq > subscribed.seq` (and those without `seq`).
- Server side: the room keeps the subscribed hub ids (`hub_subscribers`) and calls `UserHub.deliver` per event; a hub with no subscribed socket answers `subscribed: false` and is dropped.

## Account and billing

M2. All amounts in credits are integers (1 credit = $0.01 retail, D-006); money is in USD cents. Times are epoch ms. Billing reads use the auth context (current workspace, `x-workspace-id`).

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/billing/plans` | public | Plans, top-up rules and `current` (below) |
| GET | `/api/billing` | any member | Billing summary (below) |
| POST | `/api/billing/checkout` | owner (plan), editor (topUp) | Body below → `{ url, sessionId, credits? }`; redirect the window to `url` |
| GET | `/api/billing/checkout/:sessionId` | any member | Outcome for the return page (below) |
| GET | `/api/billing/seats/preview?seats=N` | owner | Team (D-013): `{ seats, current, used, interval, prorationCents, renewalCents, periodEnd, addedMonthlyCredits }`. `prorationCents` estimates the charge now for added seats (Stripe invoices the exact amount); `renewalCents` = base + (seats − 1) × seat price. Not on Team → `402 TEAM_REQUIRED { currentPlan }` |
| PATCH | `/api/billing/seats` | owner | Team (D-013): `{ seats }` (members incl. owner, 1..200) → `{ seats: { purchased, used }, granted, changed, balance? }`. Increase: Stripe `proration_behavior: always_invoice` + `payment_behavior: pending_if_incomplete` (charged now, applied only once paid; declined → `402 PAYMENT_FAILED`, seats unchanged); `granted` = prorated plan credits for the added seats. Decrease: `proration_behavior: none` (no refund; the next invoice charges fewer seats). Below seats in use → `409 SEATS_IN_USE { seats, used }`. Not on Team → `402 TEAM_REQUIRED { currentPlan }`. Optional `Idempotency-Key` header |
| POST | `/api/billing/portal` | owner | `{ returnTo? }` → `{ url }` (Stripe customer portal: card, plan change, cancel, invoices). No Stripe customer yet → `402 NO_PLAN` |
| GET | `/api/billing/payment-method` | owner | `{ paymentMethod: { id, type, brand, last4, expMonth, expYear, wallet } \| null }` — the Stripe customer's default payment method (else the live subscription's); null without a customer or card. Changes go through the portal |
| PATCH | `/api/billing/auto-topup` | owner | `{ enabled, thresholdCredits? = 200, amountCents? = 1000 }` → `{ autoTopUp: { enabled, thresholdCredits, amountCents } }`. Enabling without a plan → `402 NO_PLAN`; amount outside $10–$10,000 → `400 VALIDATION_FAILED` |
| GET | `/api/billing/ledger` | any member | `?first=1..100 (25)&after=<cursor>` → `{ lines: LedgerLine[], pageInfo: { hasNextPage, endCursor } }`, newest first |
| GET | `/api/billing/invoices` | owner | `{ invoices: [{ id, number, createdAt, amountCents, currency, status, url, pdfUrl }] }` (Stripe invoices: plans and top-ups) |
| POST | `/api/stripe/webhook` | Stripe | Signature-verified, idempotent via `stripe_events` (below) |
| POST | `/api/hooks/:provider` | provider | provider job webhooks → `workflow.sendEvent` |

`GET /api/billing/plans`:

```json
{
  "currency": "USD",
  "plans": [{ "id": "plus", "label": "Plus", "monthlyCredits": 800, "prices": { "month": 1500, "year": 14400 }, "yearlyDiscount": 0.2,
              "topUpBonus": 0.05, "concurrentJobs": 5, "maxVideoResolution": "1080p", "maxImageResolution": "2K", "voiceCloning": true, "kind": "personal", "seats": 1 }],
  "teamSeat": { "prices": { "month": 2500, "year": 24000 }, "monthlyCredits": 500, "concurrentJobs": 2, "maxConcurrentJobs": 30, "agentAllowanceUsd": 3, "minSeats": 1, "maxSeats": 200 },
  "topUp": { "minCents": 1000, "maxCents": 1000000, "tiers": [{ "minCents": 1000, "bonus": 0 }, { "minCents": 2500, "bonus": 0.04 }, { "minCents": 5000, "bonus": 0.1 }, { "minCents": 10000, "bonus": 0.15 }], "presetsCents": [1000, 2500, 5000, 10000, 25000] },
  "autoTopUp": { "thresholdCredits": 200, "amountCents": 1000 },
  "paymentsEnabled": true,
  "current": { "plan": "plus", "isMember": true }
}
```
`current` is `null` when signed out. `paymentsEnabled` is `false` while Stripe is not configured (checkout answers `503`); the upgrade modal then shows its “Payments aren’t available yet” state. Top-up credits for an amount: `quoteTopUp(amountCents, plan)` in `@rolling/core/pricing/config` (the client may use it for the live preview; the server recomputes).

`GET /api/billing` (same as GraphQL `billing`):

```json
{ "plan": "plus", "interval": "month", "status": "active", "renewsAt": 1767225600000, "cancelAtPeriodEnd": false, "periodEnd": 1767225600000,
  "balance": { "plan": 453, "purchased": 2725, "held": 0, "planExpiresAt": 1767225600000 },
  "autoTopUp": { "enabled": true, "thresholdCredits": 200, "amountCents": 1000 },
  "seats": null, "periodStart": 1764633600000 }
```
`seats` is `{ purchased, used }` on Team (used = members incl. owner + pending invites), `null` otherwise (D-013).
`plan`/`interval` are `null` without a live subscription (`active`, `trialing` or `past_due` and period not over); `renewsAt` is `null` when the plan ends at period end. `balance.plan` and `balance.purchased` are available credits; `held` is reserved by running jobs. `autoTopUp` is `null` until set.

`POST /api/billing/checkout` body (Zod, discriminated by `kind`):

```ts
{ kind: "plan", planId: "starter" | "plus" | "pro" | "team", interval: "month" | "year", seats?: number /* Team only, 1..200, default 1 */, resume?: { runQuoteId: string }, returnTo?: string }
{ kind: "topUp", amountCents: number /* whole cents, 1000..1000000 */, resume?: { runQuoteId: string }, returnTo?: string }
```
- `returnTo` is an app path (default `/settings/billing`). Stripe returns to `<returnTo>?checkout=success&session_id=<id>` or `<returnTo>?checkout=canceled`.
- Plan: a workspace that already has a live plan → `409 CONFLICT` `data.reason = "already_subscribed"` (change plans in the portal; Team seats with `PATCH /api/billing/seats`). The Stripe price is found by lookup key `rolling_<plan>_<interval>`.
- Team (D-013): one subscription with two items, `rolling_team_<interval>` (quantity 1) and `rolling_team_seat_<interval>` (quantity seats − 1, omitted for 1 seat). Response adds `{ seats, amountCents }`. `seats` on a personal plan (≠ 1) → `400 VALIDATION_FAILED`; fewer seats than members + pending invites → `402 SEATS_REQUIRED { seats, used, needed }`. A workspace with a live **personal** plan switches in place: the subscription's items change (prorated, charged now, `pending_if_incomplete`) and the response is `{ url: null, sessionId: null, switched: true, planId: "team", interval, seats, amountCents }` (no redirect; declined → `402 PAYMENT_FAILED`). The workspace keeps its id, projects and credits and becomes `kind: "team"`; `invoice.paid` grants Team credits.
- Top-up: members only → `402 NO_PLAN`; amount out of range or not whole cents → `400 VALIDATION_FAILED` `data: { field: "amountCents", minCents, maxCents }`. Response includes `credits` (base + tier bonus + plan bonus). The card is saved for auto top-ups.
- Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (role), `503 INTERNAL` when Stripe is not configured.

`GET /api/billing/checkout/:sessionId` → `{ sessionId, kind: "plan" | "topUp", status: "open" | "complete" | "expired", planId, interval, amountCents, credits, completedAt, seats /* Team, else null */, resume: { runQuoteId } | null }`. `complete` means the webhook has applied it (subscription stored / credits added); poll until then, then continue the pending run with `resume.runQuoteId` (re-quote on `QUOTE_EXPIRED`). Other workspaces' sessions → `404`.

`LedgerLine` (REST and GraphQL): `{ id, kind, bucket: "plan" | "purchased", amount, userId, runId, jobId, stripeRef, note, createdAt }`. `amount` is signed:

| kind | amount | meaning |
|---|---|---|
| `grant` | + plan | plan credits for a period (`note`: `<plan>:<interval>`); Team seats added mid-slice (`note`: `team:seats:<from>-><to>`, prorated) |
| `purchase` | + purchased | top-up (`stripeRef`: PaymentIntent id; `note`: `checkout` or `auto`) |
| `hold` | − | reserved for a job (moves to `held`) |
| `settle` | − | spent from the job's hold (the run's cost is the sum of its `settle` lines) |
| `release` | + | unspent part of a hold returned at settle |
| `refund` | + | whole hold returned when a job fails or is canceled (`note`: reason) |
| `expire` | − plan | plan credits expired at period end, on renewal or cancellation |

The D1 mirror is eventually consistent (queue, usually under a few seconds); balances come from `GET /api/billing` / `/api/me`.

Webhook (`POST /api/stripe/webhook`): raw body, `Stripe-Signature` verified with HMAC-SHA256 (WebCrypto equivalent of `constructEventAsync`, 300 s tolerance). Bad or stale signature → `400 BAD_REQUEST` `data.reason` (`missing_header`, `malformed_header`, `no_signature_match`, `timestamp_outside_tolerance`, `invalid_payload`). Already processed event id → `200 { received: true, duplicate: true }`; otherwise `200 { received: true, handled }`; processing errors → `500` so Stripe retries (every effect is idempotent). Subscribe the endpoint to:

| Event | Effect |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | plan: store the subscription (`subscriptions`, re-read from Stripe); top-up (paid): verify `amount_total` against the session metadata, recompute credits with `quoteTopUp`, `CreditAccount.purchase` keyed by the PaymentIntent |
| `checkout.session.expired` | checkout row → `expired` |
| `invoice.paid` | plan credits for the invoice period (`CreditAccount.grant` with the Team seats, leftover plan credits expire); paid upgrade mid-period (compared with the plan the slice was granted for) grants the new plan; other plan changes update limits and Team seats (`setSeats`, prorated credits for added seats) ; late invoices for older periods are ignored |
| `customer.subscription.created`, `.updated` | store status, plan, period, `cancel_at_period_end`, `seats` (seat item quantity + 1); active: limits follow the plan and `CreditAccount.setSeats(seats, "seats:<event id>")` — added seats get the prorated share of 500 credits each for the current month slice, once per slice (removing and re-adding a seat grants nothing new) |
| `customer.subscription.deleted` | status `canceled`; plan credits expire (purchased stay) |
| `invoice.payment_failed` | store status (e.g. `past_due`); email the owner (`billing.payment_failed`) |
| `payment_intent.succeeded` | auto top-up backup: credits once (same key as BillingWorkflow) |

Auto top-up: after any CreditAccount commit that leaves available credits below `thresholdCredits` (members with auto top-up on), `BillingWorkflow` charges `amountCents` off-session to the saved card and adds `quoteTopUp` credits. At most one attempt per window (until a top-up lands or settings change); a declined card is not retried.

Realtime: `credits.changed` on the user socket is not emitted by billing yet.

CreditAccount RPC (Durable Object per workspace, `billing/credits.ts` helpers `creditAccount(env, workspaceId)`, `unwrapLedger(outcome)`, `quoteCredits(env, workspaceId, items)`). Every method returns `{ ok: true, value } | { ok: false, error: { code, message, data } }`; mutations take an idempotency key and return the first result on repeats (same key with other arguments → `IDEMPOTENCY_CONFLICT`).

| Method | Result / errors |
|---|---|
| `quote(items: { ref, modelId, request? }[], catalog: ListingModel[])` | `{ quoteId, items: [{ ref, modelId, credits, blocked?: unknown_model\|unpriced\|resolution_locked, lowestPlan? }], total, balance, balanceAfter, expiresAt }`; valid 10 min |
| `hold({ quoteId, runId, userId, idemKey, refs?, memberMonthlyLimit? })` | `{ quoteId, runId, jobs: [{ jobId, ref, modelId, credits }], total, balance }` · `NO_PLAN`, `INSUFFICIENT_CREDITS { needed, balance }`, `MEMBER_LIMIT_REACHED { limit, used, needed }`, `CONCURRENCY_LIMIT { limit, active, requested }`, `QUOTE_EXPIRED`, `NOT_FOUND`. Plan credits first, then purchased. `refs` holds part of a quote; the rest can be held by the same run within 24 h |
| `settle(jobId, actual, idemKey)` | `{ jobId, spent, returned, clamped, balance }`; spends `min(actual, hold)` · `JOB_CLOSED`, `NOT_FOUND` |
| `release(jobId, reason, idemKey)` | `{ jobId, refunded, balance }` · `JOB_CLOSED`, `NOT_FOUND` |
| `grant({ planId, interval, start, end }, idemKey)` · `purchase(credits, ref, idemKey, source?)` · `expire()` · `cancelPlan(idemKey)` · `setPlan(planId)` · `setAutoTopUp(settings)` | webhook / alarm driven |
| `balance()` · `summary()` · `audit()` | `{ plan, purchased, held, planExpiresAt }` · plus plan, period, autoTopUp · reconcile with ledger lines |

REST mapping of these codes: `NO_PLAN` 402, `INSUFFICIENT_CREDITS` 402, `MEMBER_LIMIT_REACHED` 403, `CONCURRENCY_LIMIT` 429 (`data: { limit, active, requested }`), `QUOTE_EXPIRED` 409, `JOB_CLOSED` / `IDEMPOTENCY_CONFLICT` 409 `CONFLICT` with `data.reason`.

GraphQL (read-only, signed in; `UNAUTHENTICATED` otherwise):

```graphql
billing: Billing!            # { plan interval status renewsAt cancelAtPeriodEnd periodEnd balance { plan purchased held planExpiresAt } autoTopUp { enabled thresholdCredits amountCents } }
ledger(first: Int = 25, after: String): LedgerConnection!   # edges { cursor node { id kind bucket amount userId runId jobId stripeRef note createdAt } } pageInfo { hasNextPage endCursor }
```

## Workspaces and team
All act on the current workspace (`x-workspace-id`, default personal). Only Team workspaces invite (D-013): seats are bought on the Team subscription; members (owner included) and pending invites each use one. Accepting an invite turns its seat into a member seat; removing a member or revoking an invite frees one (the purchased count stays until the owner lowers it).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspace/members` | Any member → `{ members: [{ userId, name, email, image, role, monthlyCreditLimit, isYou }], invites: [{ id, email, role, invitedBy, createdAt, expiresAt }] (owners only; others get []), seats: { used, limit, team } }`. `limit` = purchased Team seats (1 without Team); `team` = the workspace is on Team |
| POST | `/api/workspace/invites` | Owner. `{ email, role: "editor"\|"viewer", monthlyCreditLimit?: integer ≥ 0 \| null }` → `201 { invite }` (`invite.monthlyCreditLimit`; applied to the member on accept) and an email with the link `<PUBLIC_APP_URL>/invite/<token>` (valid 7 days). A new invite to the same address replaces the pending one. Errors: `402 TEAM_REQUIRED` (`data: { currentPlan }`, null without a plan) → open "Start Team to invite people"; `402 SEATS_REQUIRED` (`data: { seats, used, needed }`, `needed` = total seats this invite requires) → open "Add seats"; `409 CONFLICT` (already a member), `403 FORBIDDEN` (not owner) |
| GET | `/api/workspace/invites/lookup?token=` | No session needed → `{ workspace: { id, name }, inviterName, email, role, expiresAt, state: "pending"\|"accepted"\|"revoked"\|"expired" }`; `404` unknown token. For the `/invite/:token` screen |
| POST | `/api/workspace/invites/accept` | Session required. `{ token }` → `{ workspace: { id, name, kind }, role }`. The signed-in email must match the invite (`403 FORBIDDEN`); used/expired/revoked → `409 CONFLICT` (`data.state`); the workspace left Team → `402 TEAM_REQUIRED`; no free seat → `402 SEATS_REQUIRED`. Then switch with `x-workspace-id` |
| DELETE | `/api/workspace/invites/:id` | Owner; revokes a pending invite → `{ ok: true }` |
| PATCH | `/api/workspace/members/:userId` | Owner. `{ role?: "owner"\|"editor"\|"viewer", monthlyCreditLimit?: integer ≥ 0 \| null }` → `{ member: { userId, role, monthlyCreditLimit } }`. The last owner cannot step down (`409`) |
| DELETE | `/api/workspace/members/:userId` | Owner removes a member, or a member leaves (own id). Not the last owner, not your own personal workspace (`409`) → `{ ok: true }` |

Roles: owner (members, invites, limits, billing), editor (create and edit), viewer (read). Routes use `requireUser`, `requireMember` (`402 NO_PLAN`) and `requireRole(min)` (`403 FORBIDDEN`, `data: { required, role }`) from `apps/api/src/auth/context.ts`.

### Staging test inbox
With the var `EMAIL_PROVIDER=test-inbox` (refused in production) emails are stored in D1 for 24 h instead of sent. `GET /api/test/inbox?to=<email>&limit=10` with `authorization: Bearer <TEST_INBOX_TOKEN>` → `{ messages: [{ to, subject, text, code, template, sentAt }] }`, newest first; `401` bad token; `404` when the provider is not `test-inbox`.

## Projects and graph

Every project belongs to a workspace. Reads need membership of that workspace (any role); writes need `editor` or `owner`. Missing and foreign projects both answer `404 NOT_FOUND`. Graph state lives in the `ProjectRoom` Durable Object; D1 `projects` is the index, updated by ProjectRoom after commits (debounced ~2 s: title, `updated_at`, `node_count`, thumbnail — never a mature output).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects` | `?first=1..100 (24)&after=<cursor>` → `{ items: Project[], nextCursor }`, current workspace, recently updated first. GraphQL: `projects(first, after) { edges { cursor node { id workspaceId title kind nodeCount updatedAt createdBy thumbUrl } } pageInfo }` |
| POST | `/api/projects` | `{ title?, fromTemplateId? }` → `201 { project }`. A template's `graph` (`{ ops }` or `{ nodes, edges, groups }`) is applied as revision 1 with fresh ids |
| GET | `/api/projects/:id` | `{ project, role, canEdit, snapshot }` (snapshot as on the WebSocket) |
| PATCH | `/api/projects/:id` | `{ title }` → `{ project }` |
| DELETE | `/api/projects/:id` | deletes the room, the index row and revokes share links; open sockets get `error { code: PROJECT_DELETED }` and close `4410` |
| POST | `/api/projects/:id/patch` | `{ baseRevision, ops: GraphOp[], origin?: "user"\|"agent" }` → `{ revision, ops, idMap, statuses }`. `409 CONFLICT` `data.snapshot` when `baseRevision` is stale; `422 VALIDATION_FAILED` `data.refusal` (`{ code, message, opIndex, data }`) when an op is refused |
| POST | `/api/projects/:id/undo`, `/redo` | the caller's own last patch → `{ revision, ops, statuses }`; `409` `data.reason: NOTHING_TO_UNDO \| NOTHING_TO_REDO` |
| GET | `/api/projects/:id/ws` | WebSocket to ProjectRoom (below) |
| GET | `/api/nodes/:id/versions?projectId=` | `{ nodeId, activeVersionId, versions: [{ id, n, assetId, inputDigest, model, jobId, createdAt, rating, active, stale, mature, url, thumbUrl }] }`, newest first. `rating` is the D-005 content rating (`safe | suggestive | explicit | null`); `mature` is true when the asset is mature or the rating is `suggestive`/`explicit`. `stale` = made with inputs that differ from the node's current inputs. `url` is null for mature outputs the viewer may not see |
| POST | `/api/nodes/:id/active` | `{ projectId, versionId }` → `{ version, statuses }`; broadcasts `node.version` |

`Project`: `{ id, workspaceId, title, kind, nodeCount, updatedAt, createdBy, thumbUrl }` (times are epoch ms).

**GraphOp** (`@rolling/core/graph` `LocalOp` plus node flags; validated by `@rolling/core/project`): `addNode { tempId, kind, title, params, position? }`, `updateNode { nodeId, params, title? }` (a param set to `null` is removed), `moveNode { nodeId, position }`, `connect { from, to, edgeId? }`, `disconnect { edgeId }`, `removeNode { nodeId }`, `group { nodeIds, title, groupId? }`, `ungroup { groupId }`, `setBypass { nodeId, bypass }`, `setCollapsed { nodeId, collapsed }`, `addReroute { edgeId, index, position }`, `moveReroute { edgeId, index, position }`, `removeReroute { edgeId, index }` (≤ 16 points per edge; `REROUTE_NOT_FOUND`, `TOO_MANY_REROUTES`). Flag and reroute semantics are `@rolling/core/graph` `applyFlagOp`, shared with the canvas.
- Ids: `addNode.tempId` starting with `node_` is kept as the node id (client-chosen, must be unique, else `DUPLICATE_ID`); any other temp id gets a fresh `node_…` id and can be referenced by later ops of the same patch. `edgeId` must start with `edge_`, `groupId` with `grp_`; both are generated when absent.
- Patches are atomic: the first refused op refuses the whole patch. Refusal codes: `NODE_NOT_FOUND`, `EDGE_NOT_FOUND`, `PORT_NOT_FOUND`, `PORT_TYPE_MISMATCH`, `SELF_CONNECTION`, `DUPLICATE_EDGE`, `CYCLE`, `PORT_FULL`, `DUPLICATE_ID`, `EMPTY_GROUP`, `INVALID_OP` (schema), `TOO_LARGE` (params > 32 KB, > 2000 nodes). `message` is a human-readable English reason (e.g. “Image nodes don’t take audio input.”).
- Nodes added without `position` are laid out left to right by dependency, to the right of the existing graph; the broadcast ops carry the final positions.
- The server returns and broadcasts **normalized ops** (final ids, positions); clients apply those.
- Staleness: each node has an input digest (kind, params, and for each input its upstream's active version, digest and bypass flag). A version records the digest it was made with; `status` is derived: `done` when the active version matches, `outdated` (“Input changed”) when not, `idle` without a version; `queued`/`generating`/`failed` are runtime states set by jobs. Changed statuses come back as `statuses: { nodeId: status }`.
- Bypass/collapse are node columns (`bypass`, `collapsed` as 0/1 in snapshot rows). A bypassed node passes through its first input of its own output type; otherwise its dependents are blocked in run plans.

### ProjectRoom WebSocket (`/api/projects/:id/ws`) — deprecated

**Deprecated (D-014):** use `subscribe` on the global socket `/api/ws`. This per-project socket stays until the web client has switched, then it is removed.

Envelope `{ type, id, payload }` both ways. Auth: session cookie (dev header `x-dev-user` / `?devUser=` in development); optional `?workspaceId=`. Not signed in → close `4401`, not a member or missing → close `4404` (accepted, `error`, closed; see close codes). Viewers get a read-only socket (`hello.canEdit = false`; writes answer `error { code: FORBIDDEN }`). A raw `ping` text frame is answered `pong` without waking the room.

Server → client, on connect: `hello { actor, canEdit }`, then `snapshot`:
```ts
{ projectId, workspaceId, title, revision,
  canvases: [{ id: 'cnv_…', title, viewport }],
  nodes: [{ id, canvas_id, kind, title, params /* JSON string */, x, y, group_id, active_version_id, status,
            created_by: 'user'|'agent', updated_at, bypass: 0|1, collapsed: 0|1,
            version_n?, version_total?, asset_id? /* active version */ }],
  edges: [{ id, canvas_id, from_node, from_port, to_node, to_port, ord, pinned_version_id, reroutes /* JSON [{x,y}] or null */ }],
  groups: [{ id, canvas_id, title, color }],
  timeline: { canvasId, revision, edl } | null }
```

| Client → server | Payload | Reply (same `id`) |
|---|---|---|
| `patch` | `{ baseRevision, ops, origin? }` | `ack { revision, idMap, statuses }` · `conflict { snapshot }` · `error { code: <refusal code>, message, data: refusal }` |
| `undo` / `redo` | `{}` | `ack { revision, ops, statuses }` (apply `ops`) · `error { code: NOTHING_TO_UNDO \| NOTHING_TO_REDO }` |
| `timeline.patch` | `{ canvasId?, baseRevision, ops: TimelineOp[] }` | `ack { revision, canvasId }` · `conflict { timeline: { canvasId, revision, edl } }` · `error { code: TIMELINE_INVALID, message }` |
| `snapshot` | `null` | `snapshot` |
| `ping` | `null` | `pong` |

Clients should apply `statuses` maps (on `ack`, `graph.patched`, `node.version`) to node statuses: the server derives staleness. Server → other sockets: `job.queued { jobId, nodeId, reason? }`, `graph.patched { revision, ops, actor: 'user'|'agent', userId, kind?: 'undo'|'redo', statuses? }`, `node.version { nodeId, version: { id, n, total, assetId, rating, active, stale, createdAt }, statuses }`, `timeline.patched { canvasId, revision, ops, actor, userId }` (after `reassemble`: `ops: null, edl`), `job.progress { jobId, nodeId, progress, status }`, `job.failed { jobId, nodeId, refunded, reason }`, plus anything trusted code sends through `ProjectRoom.broadcast` (`job.done`, `credits.changed`, `proposal.created`, `agent.delta`). Unknown types → `error { code: UNKNOWN_TYPE }`; bad JSON → `error { code: BAD_MESSAGE }`.

### ProjectRoom RPC (server-side callers: runs, workflows, agent)

Get the stub with `projectRoom(env, projectId)` (`apps/api/src/lib/access.ts`). `caller = { userId, workspaceId, canEdit }`; the room re-checks the workspace on every call and returns `{ ok: false, code, message }` errors (`lib/room.ts` `unwrap`/`orFail` map them to REST errors).
- `applyPatch(caller, { baseRevision, ops, origin? }, { except? })` → `{ ok, revision, ops, idMap, statuses }` (broadcasts `graph.patched`; `origin: 'agent'` marks created nodes as agent-made; `except: { userId, connId }` = the gateway connection that gets the ack instead). `undo(caller, { except? })` / `redo(caller, { except? })` likewise
- `hubSubscribe(caller, { lastRevision?, lastSeq? })` / `hubUnsubscribe(userId)` — D-014 gateway registration and catch-up (UserHub only)
- `registerThread(threadId, caller)` / `unregisterThread(threadId)` / `notifyThreads()` — agent threads with pending patch proposals; after commits (coalesced, 300 ms) the room calls `AgentSession.onRevision(caller)` so proposals rebase (or go stale) eagerly; a thread with nothing pending is dropped
- `undo(caller)`, `redo(caller)`
- `getSnapshot(caller)`, `getGraph(caller)` → `{ state: GraphState, assets: { nodeId: assetId } }`
- `planRun(caller, { scope: 'node'|'selection'|'all'|'upTo'|'from', nodeIds? })` (`upTo`/`from` node sets come from `@rolling/core/graph` `runScopeNodes`, bypass from `bypassSource`, like the canvas) → `{ ok, revision, items: [{ nodeId, kind, title, action: 'run'|'reuse'|'blocked'|'bypassed'|'none', reason?, message?, model, params, inputDigest, inputs: [{ port, nodeId, assetId, pending }], dependsOn }] }` in dependency order. Pricing is the quote route's job.
- `inputDigest(caller, nodeId)` → `{ ok, digest }`
- `addVersion({ nodeId, assetId, inputDigest, model?, jobId?, output?, rating? })` → new active version; broadcasts `node.version`. `rating` (D-005, from the generation postCheck; else a valid `output.rating`) is stored in `node_versions.rating` (DO migration 5) and appears in versions, `node.version` and snapshot node rows (`version_rating`). `getGraph` also returns `ratings` (node id → active version rating)
- `markRunning({ nodeId, jobId, progress?, status?: 'queued'|'generating' })` → broadcasts `job.progress`
- `markFailed({ nodeId, jobId, refunded, reason })` → status `failed`, broadcasts `job.failed`
- `markQueued({ nodeId, jobId, reason? })` → status `queued`, broadcasts `job.queued`
- `resetNode({ nodeId, reason?: 'canceled'|'retry'|'reset' })` → clears failed/canceled/queued/generating back to the derived status (done / outdated / idle); broadcasts `node.version { nodeId, version | null, status, statuses, reason? }`. Use for canceled items instead of `markFailed`
- `broadcast(type, payload)` → fan-out of any `ServerMessageType`
- `listVersions`, `setActiveVersion`, `getTimeline`, `patchTimeline`, `reassembleTimeline`, `setTitle`, `destroy`, `init`, `flushIndex`

## Runs (M4)

Auth: signed in (dev header in development), role editor+ in the workspace. Quotes are open to non-members (they see prices); starting a run needs an active plan (D-007). Implementation: `apps/api/src/routes/runs.ts`, `apps/api/src/runs/*`, planning in `@rolling/core/generation` on top of `ProjectRoom.planRun`.

| Method | Path | Body → response |
|---|---|---|
| POST | `/api/runs/quote` | Canvas: `{ projectId, scope: 'node'\|'selection'\|'all'\|'upTo'\|'from', nodeIds? }` (`node`, `upTo`, `from` take exactly one id; `selection` one or more; `all` none). Tool page: `{ promptSpec, projectId? }`. → `QuoteResponse` |
| POST | `/api/runs` | `{ quoteId, options?: { forceFailure?: true \| itemRefs[] } }` → `201 { runId, status }`. Same quote again → the same run. Errors: `NO_PLAN` (402), `INSUFFICIENT_CREDITS` (402, `{ needed, balance }`), `QUOTE_EXPIRED` (409), `MEMBER_LIMIT_REACHED` (403, `{ limit, used, needed }`), `NOT_FOUND`, `CONFLICT` (nothing to run). |
| POST | `/api/runs/:id/cancel` | → `{ runId, refunded, canceled }`: pending items stop, running jobs are terminated and their holds released (refund). |
| GET | `/api/runs` | Activity. Query: `status=queued\|running\|done\|partial\|failed\|canceled`, `projectId`, `model`, `from`, `to` (epoch ms), `first` (≤100, default 30), `after` (cursor). → `{ stats, runs: RunView[], nextCursor }` |
| GET | `/api/runs/:id` | → `{ run: RunView }`; `404 NOT_FOUND` for unknown and other workspaces' runs. GraphQL: `run(id)` |
| POST | `/api/runs/:id/retry` | no body. Re-quotes the `failed` / `canceled` / `skipped` items of a finished run with the same request (tool runs: the stored `promptSpec`, only those item refs, later items use the earlier run's outputs; canvas runs: `scope: 'selection'` over those nodes as they are now) → `QuoteResponse & { retryOf }`. The client confirms it like any quote (`needsConfirm`, paywalls, plan caps); `POST /api/runs { quoteId }` starts it and the new run has `retryOf`. `409 CONFLICT` `data.reason: RUNNING \| NOTHING_TO_RETRY \| NOT_RETRYABLE \| NODES_REMOVED`. Open to non-members like quotes (the start answers `NO_PLAN`) |

```ts
type QuoteResponse = {
  quoteId: string | null          // null when no row runs (only reuse/blocked/none): nothing to confirm
  items: Array<{
    ref: string                   // node id, or 'spec' for a promptSpec
    nodeId: string | null
    title: string; kind: string
    action: 'run' | 'reuse' | 'blocked' | 'none' | 'bypassed'
    model: string | null          // gateway id (Auto is resolved here, D-009)
    modelName: string | null      // display name ('Auto' only when Auto found no model)
    credits: number               // > 0 only on run rows
    code?: 'missing_input' | 'upstream_blocked' | 'bypassed_input' | 'unknown_model' | 'no_capable_model'
         | 'unsupported' | 'unpriced' | 'resolution_locked' | 'mature_not_allowed'
         | 'identity_requires_platform_assets' | 'empty_prompt'
         | 'SAFETY_BLOCKED' | 'MATURE_REQUIRED' | 'SAFETY_REVIEW' | 'NO_PLAN'   // D-005, see Safety below
    reason?: string               // English; the UI maps `code` to copy ('Already running' on reuse rows of running nodes)
    lowestPlan?: 'starter' | 'plus' | 'pro' | null   // resolution_locked: plan that unlocks it
    autoVia?: 'classifier' | 'fallback' | 'single'
    dependsOn: string[]           // run rows: refs that must finish first
  }>
  total: number; balance: number; balanceAfter: number
  expiresAt: number | null        // epoch ms (10 minutes)
  confirmThreshold: number        // prefs.confirmThreshold (default 300, D-006)
  needsConfirm: boolean           // total >= confirmThreshold → show RunConfirm; else start directly
}

type PromptSpec = {
  kind: 'image' | 'video' | 'remix' | 'avatar' | 'character'
  model?: string /* id, display name or 'auto' (default) */; prompt?: string; title?: string
  seconds?: number; resolution?: string; ratio?: string; audio?: boolean; n?: number
  negativePrompt?: string; seed?: number; mature?: boolean; refsMode?: boolean
  shots?: Array<{ prompt?: string; seconds?: number; frameAssetId?: string; startSec?: number }>   // remix, ≤ 12
  name?: string                                    // character: saved under this name
  views?: Array<'body' | 'face'>                   // character, default both
  inputs?: { firstFrameAssetId?, lastFrameAssetId?, referenceAssetIds?: string[], inputAssetIds?: string[], audioAssetId?,
             photoAssetId? /* avatar */, videoAssetId? /* remix */ }
}
// Items per kind (ref → what it makes); plan caps (D-006), mature routing and identity rules (D-005), safety pre-checks and Auto (D-009) apply per item:
// - image | video → one item `spec`.
// - avatar → `avatar`: video on a lip-sync model (Auto → `lumina/wan2.7-i2v-spicy`, D-009; a model without lip sync → `unsupported`):
//   the photo is the first frame, `audioAssetId` (an uploaded audio asset; TTS is open → `missing_input` “Upload a voice track.”) goes to `audio_url`,
//   `audio: true`, seconds = the track length (clamped to the model range). Mature avatars take only platform pictures
//   (generated, Characters, public library) → else `identity_requires_platform_assets`.
// - remix → `shot-1…shot-N` (one per `shots[]`, default one): refs-mode video with the reference video (`videoAssetId`, required),
//   the shot's `frameAssetId` and `referenceAssetIds` (new characters/outfits) as references; seconds = shot.seconds ?? seconds ?? the shot's segment.
//   Shot starts: `startSec` when the user set any; else the video's detected scene cuts (`meta.sceneCuts`, found by the FFmpeg container's
//   `/scenes` when the upload was processed) when there are enough; else an even split. A shot without `frameAssetId` gets the reference
//   video's frame at its start as a picture (extracted in `prepare` by the container's `/frames`, PUT to a presigned R2 URL,
//   `ws/<ws>/frames/<assetId>/<ms>.png`, reused); container unreachable → the poster frame, else the frame is left out.
//   Models without reference-video input get that frame (or the poster) in place of the video.
// - character → `body` (full figure, 3:4) then `face` (1:1 close-up made from the body output, `dependsOn: ['body']`), image generations or edits
//   with `referenceAssetIds`. When the run ends with at least one picture, it is saved to Characters (`RunView.characterId`; a retry adds a version).

type RunView = {
  id; ref /* 'T-xxxxx' */; name; source: 'canvas' | 'quickCreate'; projectId; projectTitle
  params /* 'Seedance 2.0 Mini · 480p · 9:16 · 5s' */
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'canceled'
  progress: number | null         // 0..1 while queued/running
  credits: number                 // quoted while queued/running, charged after
  quoted; spent; refunded; error: string | null; createdAt; finishedAt
  items: Array<{ ref, nodeId, title, kind, model, modelName, status: 'pending'|'running'|'succeeded'|'failed'|'skipped'|'canceled',
                 jobId, progress, credits, spent, refunded, assetId, error, errorCode }>
  request: { promptSpec: PromptSpec } | { scope, nodeIds? } | null   // the normalized request it was quoted from (null before migration 0015)
  tool: 'quick' | 'remix' | 'avatar' | 'character' | null           // tool runs (`quick` = image/video); null for canvas runs
  retryOf: string | null; characterId: string | null
  retryable: boolean               // failed/canceled/skipped items can be re-quoted with POST /api/runs/:id/retry
}
// stats: { usedThisMonth, usedLastMonth, running, successRate /* 0..1 | null, 7 days */, runsLast7Days, refundedThisMonth }
```

Rules:
- Tool-spec inputs: `ready` assets of the workspace (and builtin/public ones) and **the caller's own uploads still `processing`** are usable (the bytes are in R2 once `complete` returned; probing only adds metadata). `uploading` / `failed` / deleted assets block with `missing_input` “An input file is not available.” Until probing, video/audio lengths come from the upload's `durationMs`; items quoted with such a length carry `spec.declaredDurations`, and `prepare` fails the job with `input_changed` (refunded, “Quote again.”) when the probed file is longer than declared + max(1 s, 10%).
- Node params read by the planner: `model` / `modelId` (id, display name, PRD name it stands in for, or `Auto`), `prompt`, `length` (or `seconds`) for video, `resolution`, `ratio`, `count` (images), `audio` (or the `extra` label “Audio on/off”), `mature`, `mode` (“reference” → refs mode). Text and script inputs are prepended to the prompt; `@[Name]` mentions become plain names. Image models sized by `size` get `WxH` from `resolution` (1K/2K/4K) and `ratio`.
- Plan caps (D-006) use the workspace plan; mature runs (D-005) need `matureAllowed` and route only to mature-capable models (identity-driven models only with platform assets). Auto (D-009) asks DeepSeek V4.1 Flash to pick among capable candidates (2 s timeout, members only) and falls back to the cheapest candidate.
- Holds are per item: when a run starts, items whose inputs are ready are held (up to the plan's jobs at once); dependents are held and started when their inputs land. A dependent of a failed item is `skipped` (never charged). An item whose later hold fails (balance spent elsewhere) is `failed` with that code.
- Charges: settle with the provider's reported cost through `creditsFor` (3× markup), never above the hold; no cost reported → the quoted credits. Failures release the hold (`refunded` = held credits). Auto items retry once on the next fallback model that fits under the same hold.
- `options.forceFailure` (staging/development only, ignored in production): the listed items (or all with `true`) fail without calling the provider and are refunded — for testing the refund path end to end.

### Safety (D-005 hard limits)

Implementation: `@rolling/core/safety` (rules, classifiers, `preCheck` / `postCheck` / `rateMedia`, `SafetyGate`), Worker side `apps/api/src/safety/*`. Nothing here is configurable; no setting, plan, preference or env var turns a check off.

Quote item codes (`action: 'blocked'`, `credits: 0`; the copy is neutral, internal codes never reach the client):

| `code` | When | `reason` (show as is, or map) |
|---|---|---|
| `SAFETY_BLOCKED` | The deterministic rules hit a hard limit (e.g. minor-coded + sexual terms; face/head swap on a mature run). Logged. | “This can’t be generated under our content rules.” |
| `MATURE_REQUIRED` | A non-mature run whose prompt is clearly explicit (member). Not silently routed to a mature model. | “Turn on mature content in Settings to generate this, or change the prompt.” |
| `NO_PLAN` | Same, for a non-member → open Paywall `variant=join`. | “Join a plan and turn on mature content to generate this, or change the prompt.” |
| `SAFETY_REVIEW` | A mature item in a workspace flagged for review (≥ 3 hard-limit blocks in 24 h). Non-mature runs still work. | “Mature content is paused for this workspace while recent activity is reviewed.” |

Job error codes (run item / job `errorCode`, node `job.failed.reason`; the hold is always released, “No credits were charged.”):
- `safety_blocked` — the `prepare` pre-check (rules → DeepSeek V4.1 Flash text classifier → on mature runs vision on image references and `lumina/face-detect` on uploaded photographs) or the `store` post-check (vision on image outputs / the video poster frame) hit a hard limit. A post-blocked output is deleted from R2 and never registered or versioned.
- `mature_required` — a non-mature run classified explicit (prompt or output).
- `safety_unavailable` — a classifier failed or timed out on a mature run (fail closed). Non-mature runs continue when the rules pass; the outage is logged.
- `safety_review` — mature job of a flagged workspace.

Content rating: every generated output gets `assets.rating` (`safe | suggestive | explicit`), `rating_confidence`, `rating_model`; `assets.mature` follows the rating (`suggestive`/`explicit` → 1), or the run's mature flag when unrated. Share links, public surfaces and the media signer read `assets.mature`, so they follow the rating. Versions store it in the ProjectRoom `node_versions.rating` column (also kept in `output.rating`); share snapshots drop nodes whose active version is `suggestive`/`explicit` and project thumbnails skip them, even before the asset row is marked mature.

Hooks for other areas (no messages needed; call them):
- **Uploads** (wired, `media.process` consumer): after an image is `ready`, or a video is `ready` with its poster, the consumer calls `rateAsset(env, assetId)` (`apps/api/src/safety/service.ts`). It stores the rating and `mature`, and marks the asset `failed` (logged, stage `upload`) when the media itself shows a hard-limit violation; a classifier outage leaves it unrated. Videos left `processing: pending` are rated when the cron re-queue fills in the poster. Clients blur `suggestive`/`explicit` thumbnails in lists until clicked.
- **M6 agent** (wired): `AgentPorts.safety: SafetyGate` (`agentSafetyGate(env, caller)`). `checkBrief` runs at the start of every turn (block → turn ends with reason `safety_blocked` and the neutral message, no LLM call); `checkProposal` runs on every valid proposal's `prompt`/`visual` strings (block → invalid proposal with a neutral reason so the model rewrites; explicit on a non-mature turn → the mature-content reason). Non-mature turns use the free rules only; mature turns add the classifier. Events are logged with stage `agent`.

Logging: `safety_events` (D1 0009: workspace, user, run, job, stage `quote|pre|post|agent|upload`, verdict, codes, model, ≤ 200-character excerpt, no media) and Analytics Engine (`blobs: ['safety', stage, verdict, codes, model]`, `doubles: [hard, costUsd]`, index workspace). Review clears a flag with `UPDATE workspaces SET safety_flag = 0, safety_flagged_at = NULL WHERE id = ?`. Classifier assessments are cached 30 days by content hash in `safety_cache`.

GraphQL: `runs(filter: { status, projectId, model, from, to }, first, after) { nodes { …RunView } stats { … } pageInfo { hasNextPage endCursor } }`.

Live events (D-003):
- Project socket: `job.progress { jobId, nodeId, progress /* 0..1 */, status: 'queued'|'generating' }` (queued on start with `jobId: ''`), `node.version` (from `addVersion`), `job.done { jobId, nodeId, version: { n, total }, assetId }`, `job.failed { jobId, nodeId, refunded, reason }` (`reason` is English, e.g. “The provider rejected the content.”; the node shows “Refunded {refunded} credits”), `credits.changed { workspaceId, balance, held, plan, purchased }` after every hold, settle and release.
- User socket (`/api/ws`): `credits.changed` (same payload) and `activity.updated { runId, jobId? }`.

Provider webhooks: `POST /api/hooks/hyperouter` (no session). Standard Webhooks signature with `HYPEROUTER_WEBHOOK_SECRET` (`whsec_…`); bad signature → 401, stale timestamp → 401, malformed → 400; deduped on `webhook-id` (`{ ok: true, duplicate: true }`). The job's status is fetched from the gateway and sent to the job's GenerateWorkflow as `provider-done`; the workflow also polls (backoff from 3 s for images / 10 s for video up to 60 s), so a missed webhook only delays a job.

Local real end-to-end (no gateway account): `apps/api/scripts/fake-hyperouter.mjs` (node, no deps) serves `GET /v1/models` (the catalog fixture), async images and videos with fixture PNG/MP4 outputs (`Idempotency-Key` honoured, finished after `FAKE_HR_DELAY_MS`, a prompt with `[fail]` fails), streaming chat with scripted agent turns (`propose.plan`, `canvas.get` → `propose.graphPatch`, `timeline.get` → `propose.timelinePatch`, `propose.fields`) and valid classifier JSON, and Standard-Webhooks-signed callbacks to `FAKE_HR_WEBHOOK_URL`. The Worker uses it when `HYPEROUTER_BASE_URL` points at it. `PW_REAL_LOCAL=1` (apps/web/playwright.config.ts) starts it with `wrangler dev` (state in `apps/api/.wrangler/e2e-real`) and the real-mode SPA; the member test account gets a plan through `POST /api/test/plan`.

## Assets and libraries

Uploads are resumable and chunked and go **directly from the browser to R2** with presigned URLs (D-011); the Worker never carries upload bytes. Downloads are resumable (`Range`). Bytes are served only through signed media URLs (D-008), never from `/api`.

**Upload flow:** `POST /api/assets/uploads` → `POST …/part-urls` → browser `PUT`s each part to its URL (parallel is fine; keep each response's `ETag` only for your own progress) → `POST …/complete`. To resume after a reload, call `POST /api/assets/uploads` again with the same `fingerprint` (or `GET …/:assetId`) and upload only the parts not listed in `parts`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/assets/uploads` | `{ filename, contentType, size, fingerprint?, projectId?, name?, durationMs? }` (`durationMs`: audio/video length as the browser reports it; stored as `meta.durationSec` with `durationSource: 'declared'` until probing replaces it) → `201` new or `200` resumed: `{ assetId, key, uploadId, status: "uploading", size, partSize: 8388608, partCount, parts: [{ n, size, etag }], expiresAt, resumed, kind? }`. `fingerprint` = client hash of name + size + lastModified + first/last 1 MB; an unexpired upload of the caller with the same fingerprint, size and type in the same workspace is returned instead of a new one. Limits: images ≤ 30 MB (jpeg, png, webp, gif, avif, heic), video ≤ 2 GB (mp4, quicktime, webm), audio ≤ 200 MB (mpeg, mp4/m4a, aac, wav, ogg, webm, flac); `413` / `415` `VALIDATION_FAILED` with `data.reason: TOO_LARGE \| UNSUPPORTED_TYPE`, `maxBytes`, `limits`. Editors and owners; rate-limited (`429 RATE_LIMITED`) |
| GET | `/api/assets/uploads/:assetId` | `{ assetId, key, uploadId, status: uploading\|complete\|aborted\|expired, size, partSize, partCount, parts: [{ n, size, etag }], expiresAt }`. `parts` come from R2 (S3 `ListParts`), so they are exactly what storage has |
| POST | `/api/assets/uploads/:assetId/part-urls` | `{ partNumbers: n[] (≤ 100) }` → `{ assetId, direct, urls: [{ n, size, method: "PUT", url, expiresAt }] }`. `url` is a presigned S3 `UploadPart` URL (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?partNumber=n&uploadId=…&X-Amz-…`, 1 h). Part `n` must be exactly `size` bytes (8 MiB except the last). Re-sending a part replaces it. Rate-limited |
| POST | `/api/assets/uploads/:assetId/complete` | no body. Lists the parts R2 has, checks count and sizes against the declared size (`400 VALIDATION_FAILED` `data.reason: MISSING_PARTS (missing[]) \| EXTRA_PART \| PART_SIZE (n, expected, got)`), completes and queues `media.process` → `{ asset }` (`status: processing`). Idempotent: a completed upload returns the asset again |
| DELETE | `/api/assets/uploads/:assetId` | aborts the multipart upload and removes the pending asset → `{ ok, status }` |
| PUT | `/api/assets/uploads/:assetId/parts/:n` | **development fallback only** (no R2 S3 credentials, `ENVIRONMENT=development`): `part-urls` then return these Worker URLs (`direct: false`); body = raw part bytes with `Content-Length` → `{ n, etag, size }`. `404` everywhere else |

Uploads are only visible to their uploader. They expire 7 days after creation (R2's limit): `status: expired`, and the 6-hourly cron aborts them. The bucket's CORS allows `PUT`/`GET`/`HEAD` from the app origins and exposes `ETag`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/assets` | `?scope=mine\|team\|builtin\|public\|all (all)&kind=image\|video\|audio\|text&q=&first=1..100 (48)&after=` → `{ items: Asset[], nextCursor }`, newest first; `q` is full-text (prefix match on name and tags). GraphQL: `assets(scope: MINE\|TEAM\|BUILTIN\|PUBLIC\|ALL, kind, q, first, after)` |
| GET | `/api/assets/:id` | `{ asset }` (own workspace, builtin or public) |
| DELETE | `/api/assets/:id` | removes the row, search entry and R2 objects (editor+) |
| GET | `/api/media/private/:assetId` | signed-in convenience: `302` to a signed URL; never carries bytes |
| GET | `/media/<key>?exp=&ws=&sig=` | signed private media (this Worker until the media hostname exists). Resumable: `Accept-Ranges: bytes`, single `Range` → `206` + `Content-Range`, unsatisfiable → `416` with `Content-Range: bytes */size`, `If-Range` (ETag or date; mismatch → full `200`), `ETag` / `If-None-Match` → `304`. `403 { reason: invalid }`, `410 { reason: expired }`. `/api/media/public/...` (public-library fallback) answers `Range` the same way |
| GET | `/api/public-library` | `?category=&sub=&q=` with license |
| GET | `/api/characters` | `{ items: [{ id, name, meta, coverAssetId, coverUrl, versions: [{ n, assetIds, createdAt }], createdAt, createdBy }] }` |
| POST | `/api/characters` | `{ name, coverAssetId?, referenceAssetIds?, meta? }` → `201 { character }`; `DELETE /api/characters/:id` |
| GET | `/api/voices` | builtin + workspace voices `{ items: [{ id, name, language, kind: builtin\|cloned, status, sampleAssetId, sampleUrl }] }` |
| POST | `/api/voices` (alias `/api/voices/clone`) | `{ name, sampleAssetId, language? }` → `202 { voice }` with `status: pending` (voice provider is an open decision). `NO_PLAN` without a plan; `403 data.reason: PLAN_FEATURE, requiredPlan: plus` on Starter; `DELETE /api/voices/:id` (cloned only) |
| GET | `/api/templates` | see Templates below |

`Asset`: `{ id, kind, source: mine|team|builtin|public|generated, name, status: processing|ready|failed, mature, rating: safe|suggestive|explicit|null (D-005; GraphQL `Asset.rating`; blur `suggestive`/`explicit`), size, contentType, license, projectId, createdBy, createdAt, url, thumbUrl, waveformUrl, meta: { width?, height?, durationSec?, processing?: queued|pending|done, tags?, sceneCuts? /* video: detected cuts in seconds */ } }`.
- Scopes: `mine` = my uploads and generations in the current workspace; `team` = the whole workspace; `builtin`; `public` (public library, never mature); `all` = workspace + builtin + public.
- D-005: mature assets are listed and signed only for viewers allowed to see them (`AuthContext.matureAllowed`); mature public-library items never appear.
- `media.process`: images get a 512 px WebP thumbnail through Cloudflare Images (fallback: the original); video/audio are probed, thumbnailed and waveformed by the FFmpeg container from a signed URL; videos also get scene cuts (`/scenes`, `select='gt(scene,0.3)'` at 320 px). Without a container (`MEDIA_CONTAINER=off`, tests, local dev) the asset becomes `ready` with `meta.processing: pending`.
- Signed URL token: `sig = base64url(HMAC-SHA256(MEDIA_SIGNING_KEY, "v1\n" + key + "\n" + exp + "\n" + ws))`, `exp` in epoch seconds (default lifetime 1 h, max 7 d). Workspace media lives under `ws/<workspaceId>/…` and is only valid with that `ws`; `ws=_` signs `builtin/` and `public/` keys. Code: `@rolling/core/media` (`signMediaKey`, `verifyMediaSignature`), `apps/api/src/lib/mediaUrls.ts` (`signMediaUrl(env, key, { workspaceId, expiresIn })`).

## Templates

Built-in templates (D1 seed migration 0016, generated from `@rolling/core/templates` `BUILTIN_TEMPLATES` by `apps/api/scripts/seed-templates.ts`; every model id is a real catalog id and every setting fits Starter) and workspace-private templates saved from a canvas selection. A template is a canvas graph (`{ nodes, edges, groups }`) plus **slots**: every asset node (a picture, clip or voice track to supply, `param: 'assetId'`) and every text/script node (`param: 'text'`), keyed by node id. Implementation: `apps/api/src/routes/templates.ts`, `@rolling/core/templates`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/templates` | `?category=&q=&first=1..100 (60)` → `{ items: TemplateSummary[], featured: TemplateSummary[], total }`, built-ins and this workspace's, most used first. GraphQL: `templates(category, q, first)` |
| GET | `/api/templates/:id` | `{ template: TemplateSummary & { graph } }`; GraphQL `template(id) { … graph /* JSON string */ }` |
| POST | `/api/templates` | "Save selection as template": `{ projectId, nodeIds (1..200), title, category?, description? }` → `201 { template }`. Editors; the selected nodes, the edges between them and wholly selected groups, moved to the origin, without versions or run state; slots inferred (asset ids stay as slot defaults). Workspace-private |
| DELETE | `/api/templates/:id` | own workspace templates only (built-ins → 404) |
| POST | `/api/projects` | `{ title?, fromTemplateId, slots?: { [slotId]: { assetId } \| { text } } }` → `201 { project }` titled like the template; the filled graph is revision 1. Nothing is quoted or spent. `422 VALIDATION_FAILED data.slot` for an unknown slot, a fill of the wrong kind, or an asset that is not ready / not usable here / of the wrong media (mature assets only for allowed viewers). Filled asset nodes record the asset's `source` (D-005 provenance) |

```ts
type TemplateSummary = {
  id; name; description: string | null; category: 'product'|'explainer'|'drama'|'holiday'|'venue'|'outfit'|'comic'|'talking' | null
  source: 'builtin' | 'workspace'
  durationSec; ratio /* '9:16' */; coverAspect /* '9/16' */; roles; hasLines; tags: string[]; featured; uses; nodeCount
  skill: string | null              // agent skill it matches (Home inspiration)
  coverUrl: string | null           // never a mature asset (D-005); built-ins: the WebP poster
  cover: { jpg, webp, avif, width, height, color /* '#rrggbb' */ } | null   // built-ins (migration 0020); coverAspect = width/height
  previewUrl: string | null         // built-in video templates: muted looping H.264 MP4 (≤ 5 s, ≤ 1.5 MB)
  slots: Array<{ id, kind: 'image'|'video'|'audio'|'text', label, param: 'assetId'|'text', required, default? }>
  createdAt
}
```

Covers: built-ins show the output of their own run (made in a content workspace through the normal quote → hold → workflow → settle path; provenance per item in `scripts/templates/covers.manifest.json`), processed by `scripts/templates/covers.mts`: poster as AVIF, WebP and JPEG at 720 px wide plus its average color, and for video templates a ≤ 5 s silent MP4 preview. Keys are content-hashed under `public/templates/<id>/` (`poster-<hash>.{jpg,webp,avif}`, `preview-<hash>.mp4`) on the public bucket; migration 0020 merges them into `meta` (`coverKey`, `coverWebpKey`, `coverAvifKey`, `previewKey`, `coverWidth`, `coverHeight`, `coverColor`) and the API builds public media URLs (`PUBLIC_MEDIA_BASE_URL`, else the `/api/media/public/templates/...` fallback, which also answers `Range` for the MP4; D-008). `durationSec` is the sum of the template's video lengths, 0 for image-only templates (cards show no duration badge). Workspace templates use `preview_asset_id` (signed, never mature).

Built-ins (34; migrations 0016, 0019, 0023; at least 6 per Home inspiration category): product — `tpl_tv_ad_15s`, `tpl_product_showcase`, `tpl_unboxing_reel`, `tpl_market_handoff`, `tpl_lifestyle_scene`, `tpl_flat_lay_promo`, `tpl_feature_closeups`; talking — `tpl_talking_head` (lip sync, `lumina/wan2.7-i2v-spicy`), `tpl_presenter_intro`, `tpl_product_review`, `tpl_how_to_host`, `tpl_announcement`, `tpl_testimonial`, `tpl_wedding_toast`; drama — `tpl_drama_dinner_party`, `tpl_drama_last_rehearsal`, `tpl_drama_rooftop`, `tpl_drama_rain_reunion`, `tpl_drama_office_twist`, `tpl_drama_letter`, `tpl_drama_cafe`, `tpl_drama_cliffhanger`; holiday — `tpl_holiday_greeting`, `tpl_new_year_countdown`, `tpl_valentines_card`, `tpl_halloween_teaser`, `tpl_lunar_new_year`, `tpl_holiday_sale`; plus `tpl_comic_page`, `tpl_character_sheet` (comic), `tpl_cooking_show`, `tpl_storyboard` (explainer), `tpl_outfit_try_on` (outfit), `tpl_concert_vlog` (venue). Migration 0023 gave the people-heavy ones Seedream 5.5 keyframes and Wan 3.0 motion (`lumina/berry-1.0`). Re-seeding merges `meta`, so covers survive. Built-ins' `created_at` holds the feed order (round-robin across categories, Home inspiration ones first; migration 0021, `builtinFeedOrder()`), so the list opens on a mix.

Showcase (the sign-in panel): `GET /api/showcase` → `{ items: Array<{ id, name, posterUrl /* WebP, else JPEG */, poster: { avif, webp, jpg }, previewUrl, aspect /* '9/16' */, width, height, color }> }`. Public (no auth, the same body for everyone): up to 12 built-ins with a preview clip and a sized poster, in feed order, never mature (`meta.mature` or a `mature`/`18+` tag), only keys already on the public bucket under the template's own folder (the same `builtinCover` rules as above). `Cache-Control: public, max-age=300, stale-while-revalidate=3600`, ETag (`If-None-Match` → `304`), edge-cached like `/api/models`. Implementation: `apps/api/src/routes/showcase.ts`. `/login` and `/signup` fall back to the design's tone tiles when it is empty or fails.

## Agent (M6)

Members only: every route that runs or applies agent work returns `402 NO_PLAN` without an active plan (D-007). Agent turns spend no credits; they draw on the plan's monthly **agent allowance** in USD of gateway cost (D-012: Starter $1.20, Plus $3.50, Pro $12.50; resets on the billing period start, else the UTC calendar month). Each turn holds its estimate in the CreditAccount DO before the first LLM call and settles its actual cost when it ends; when used + held + estimate > allowance the send returns `429 AGENT_ALLOWANCE_EXHAUSTED` with `data: { allowanceUsd, usedUsd, resetsAt, model }` (`resetsAt` epoch ms, `model` the public LLM id). DeepSeek public LLMs (`deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017`) are unmetered (D-012 amendment): no hold, cost recorded in `agent_usage` with `status: unmetered`; instead each user may send at most 300 DeepSeek turns per rolling hour, beyond which the send returns `429 RATE_LIMITED` with `data: { retryAfter /* seconds */, model }`. Proposals never spend credits or change anything until Apply.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent/allowance` | → `{ plan, allowanceUsd, usedUsd, resetsAt, models: [{ id, name, unlimited: false, estTurnUsd, turnsLeft } | { id, name, unlimited: true }] }` (DeepSeek models are `unlimited: true`). `usedUsd` includes turns in flight; `models` lists public LLM ids only (estimate: the workspace's rolling average for the model, else token prices × 10k in / 1.2k out). |
| POST | `/api/agent/threads` | `{ projectId?, surface: home\|canvas\|editor\|tool, skill?: tv-ad\|product-showcase\|storyboard\|ai-comic\|brand-kit, tool?: quick\|remix\|avatar\|character }` → `201 { thread: Thread }`. canvas/editor need `projectId`; tool needs `tool`. |
| GET | `/api/agent/threads` | `?projectId=&first=` → `{ items: [{ id, projectId, surface, skill, title, updatedAt }] }` (recent first) |
| GET | `/api/agent/threads/:id` | `{ thread: Thread }` |
| POST | `/api/agent/threads/:id/messages` | `{ text, refs?: assetIds[], selection?: nodeIds[], llm?: publicLlmId }` → runs one turn and answers when it ends: `{ turnId, messageId, text, reason, proposal: Proposal \| null, error: { code, message } \| null, llm }`. Events stream over the sockets while it runs (below). `409 CONFLICT` while another turn runs in the thread. `llm` is a public id from `/api/models` chat list (D-009; default `deepseek-v4.1-flash`) and is remembered per thread. |
| POST | `/api/agent/threads/:id/cancel` | `{ turnId? }` → `{ ok, canceled }`. Partial text stays; no proposal is created. |
| GET | `/api/agent/threads/:id/ws` | Thread socket: `hello { threadId, running }`, then this thread's events; client may send `cancel` and `ping`. |
| POST | `/api/agent/proposals/:id/apply` | `{ optionIndex?, title? }` (plan only). Applies as the user (editor role). Returns `{ ok, proposalId, kind, projectId?, canvasId?, revision?, idMap?, fields? }`. `plan`: Home threads create a project (`title` or the option title) and the thread moves to it (surface `canvas`); canvas threads add the nodes to their project. `graphPatch`: exactly the stored ops go to `ProjectRoom.applyPatch` with `origin: "agent"`. `timelinePatch`: `ProjectRoom.patchTimeline`. `fields`: returns the fields to put in the form. `409 CONFLICT` with `data.status` when the proposal is not `proposed` or became `stale`. |
| POST | `/api/agent/proposals/:id/discard` | → `{ ok: true }` |

`reason` is one of `completed`, `proposal`, `max_tool_calls`, `invalid_proposal` (three invalid proposals; the text explains), `canceled`, `error`.

**Events** (WS envelope `{ type, id, payload }`). Canvas and editor threads publish on the project socket (`/api/projects/:id/ws`, via `ProjectRoom.broadcast`); Home and tool threads on the user socket (`/api/ws`, via `UserHub.broadcast`); every thread also on its own socket. Every payload has `threadId`.

| type | payload |
|---|---|
| `agent.delta` | `{ threadId, turnId, delta }` (text, batched ~60 ms) |
| `agent.tool` | `{ threadId, turnId, name, status: started\|ok\|error, error? }` (e.g. "Checking models") |
| `proposal.created` | `{ threadId, turnId, proposal: Proposal }` |
| `proposal.updated` | `{ threadId, proposalId, status: applied\|discarded\|stale, reason? }` |
| `agent.done` | `{ threadId, turnId, messageId, reason, proposalId }` |
| `agent.error` | `{ threadId, turnId, code, message }` |
| `agent.allowance` | Same body as `GET /api/agent/allowance`. Sent on the **user socket** of the user who sent the turn, after the turn's cost is settled (no `threadId`). |

```ts
interface Thread {
  id: string; workspaceId: string; projectId: string | null; canvasId: string | null;
  surface: 'home' | 'canvas' | 'editor' | 'tool'; skill: string | null; tool: string | null; llm: string | null;
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; proposalId?: string }[];
  proposals: Proposal[];
}
interface Proposal {
  id: string; kind: 'plan' | 'graphPatch' | 'timelinePatch' | 'fields'; status: 'proposed' | 'applied' | 'discarded' | 'stale';
  baseRevision: number | null; summary: string; createdAt: number;
  estimate: { credits: number; items: { ref, model, kind: 'video' | 'image', seconds?, resolution?, credits }[]; applyIsFree: true; balanceAfter: number; needsConfirm: boolean };
  risks: ({ code: 'over_balance', data: { credits, available } } | { code: 'needs_confirm', data: { credits, threshold } } | { code: 'unpriced', data: { refs } } | { code: 'removes_user_nodes', data: { nodeIds } })[];
  body:
    | { kind: 'plan'; seconds: number; refs: string[]; options: { title; ratio; resolution; seconds; estimate: Estimate; ops: GraphOp[];
        shots: { n, title, seconds, visual, line?, model, mode: 't2v' | 'i2v', resolution, credits }[] }[] }
    | { kind: 'graphPatch'; projectId; ops: GraphOp[]; touched: { added: tempIds[], updated: nodeIds[], removed: nodeIds[], edges: number } }
    | { kind: 'timelinePatch'; canvasId; ops: TimelineOp[]; highlights: { clipId, kind: 'remove' | 'change' }[]; durationBefore; durationAfter }
    | { kind: 'fields'; tool: 'quick' | 'remix' | 'avatar' | 'character'; fields: Record<string, unknown> };
}
```

Plan options build, per shot, an image keyframe (`kind: image`, default image model, `mode: edit` when `@` images are referenced, which are added as `asset` nodes wired to `refs`) and a video node (`params: { prompt, model, mode, seconds, resolution, ratio, line? }`, `frame` from the keyframe for i2v), plus one `script` node (`params.rows: [{ n, title, visual, line?, seconds }]`) feeding every keyframe's `prompt`. Node `params.model` holds gateway model ids from the catalog. Plan proposals' plan `estimate` is the cheapest option's; each option carries its own. Estimates are the credits the later runs would cost (the run quote is authoritative).

Field schemas (`propose.fields`): `quick { kind: video|image, prompt, model?, seconds?, ratio?, resolution?, audio?, count? }`, `remix { sourceAssetId?, prompt, keep?, model?, strength?: subtle|balanced|strong }`, `avatar { script, look?, characterId?, voiceId?, background?, ratio? }`, `character { name, look, outfit?, personality?, style? }`.

## Editor

One canvas per project: `canvasId = "cnv_" + <project ULID>` (from `snapshot.canvases[0].id`). Access as for the project.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/canvases/:id/timeline` | `{ canvasId, revision, edl }`. Assembled on first open: the script node's `params.rows` (`{ n, visual, line?, seconds, nodeId? }`, `selected: false` rows skipped) become shots in order, each mapped to its `nodeId` or else to the video nodes left to right; a row's `line` becomes a caption; an audio node with an asset becomes the voiceover (`params.role: 'music'` → music). Without a script: the video nodes feeding a render node, else all video nodes left to right |
| POST | `/api/canvases/:id/timeline/patch` | `{ baseRevision, ops: TimelineOp[] }` → `{ canvasId, revision, edl, ops }`; `409 CONFLICT data.timeline`; `422 VALIDATION_FAILED data.reason: TIMELINE_INVALID` (overlap, too short, unknown clip). Broadcasts `timeline.patched`. Also over the socket as `timeline.patch` |
| POST | `/api/canvases/:id/timeline/reassemble` | rebuild from the graph, keeps manual trims (`in`/`out`) of shots whose node is still there → `{ canvasId, revision, edl }` |
| POST | `/api/canvases/:id/export` | `{ preset: "mp4_1080p" \| "mp4_720p", range?: { start, end } }` (seconds on the timeline; default the whole cut) → `201 { export: ExportView }` and ExportWorkflow starts. Editors and owners with an active plan (`402 NO_PLAN`). **Free of credits for now** (no quote, no hold; revisit with pricing). `422 VALIDATION_FAILED data.reason: EMPTY \| BAD_RANGE \| TOO_LONG` (15 min max). The cut is frozen at request time (stored at `ws/<ws>/exports/<id>/edl.json`) |
| GET | `/api/exports/:id` | `{ export: ExportView }` for members of the project's workspace (others `404`); when done, `url` is a fresh signed download URL (D-008, ~1 h; `null` for mature exports the viewer may not see) — use it as the download's `refreshUrl` |

`TimelineOp` and the EDL are `@rolling/core/timeline`. **One Zod schema for client and server** (`@rolling/core/timeline` → `TimelineOpSchema`, `EdlSchema`, `parseTimelineOps`; `@rolling/core/project` re-exports them). Ops: `trim`, `move`, `split`, `remove`, `setGain`, `setCaption`, `replaceShot { clipId, nodeId, assetId? }`, `setTransform { clipId, transform: Partial<{ scale 0.1–4, x, y, rotation −360–360, opacity 0–1 }> }`, `setSpeed { clipId, speed 0.25–4, reverse? }` (later clips on the track ripple), `setFade { clipId, fadeIn }`, `setTransition { clipId, transition: { type: "dissolve", dur } \| null }`, `insert { trackId, clip }`, `setFormat { width, height, fps }` (sides 16–4096, fps 1–60), and `replaceEdl { edl, baseRevision }` (whole timeline, for undo/redo of compound edits; `409 CONFLICT` unless `baseRevision` is the current revision; the result is checked by `validateEdl`). Ops in a patch are all-or-nothing and only the final timeline is validated (no overlaps, no clip under 0.1 s, unique ids, format in range).

```ts
type ExportView = {
  id: string                 // exp_…
  projectId: string; canvasId: string
  preset: 'mp4_1080p' | 'mp4_720p'
  range: { start: number; end: number } | null
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number           // 0..1
  width: number; height: number   // short side 1080 / 720, the EDL's aspect ratio
  duration: number           // seconds
  assetId: string | null     // the MP4 as a `generated` video asset of the project, when done
  size: number | null; fileName: string
  url: string | null         // signed download URL when done
  error: { code: string; message: string } | null
  createdAt: number; finishedAt: number | null
}
```

Events on the project channel (every payload has `exportId`, `projectId`, `canvasId`): `export.progress { status: queued|running, progress }` (monotonic), `export.done { status, progress: 1, assetId, url, fileName, size, duration, urlExpiresIn }` (`url` is `null` for mature exports: read `GET /api/exports/:id`), `export.failed { status, code, reason }` (codes: `renderer_unavailable`, `render_failed`, `ffmpeg_failed`, `input_unreadable`, `render_lost`, `upload_missing`, `timeout`, `SAFETY_BLOCKED`, `internal`). The asset is rated by the safety hook (`rateAsset`) on the poster frame; a hard-limit violation fails the export and deletes the file; any mature input makes the export mature (D-005).

Rendering: ExportWorkflow signs every input (4 h), presigns a `PUT` for `ws/<ws>/exports/<id>/export.mp4` (R2 S3 API, `aws4fetch`; without S3 credentials the workflow pulls the file from the container instead) and calls the `FfmpegRenderer` container: `POST /render` (job: cropped EDL, output size and rate, inputs, `putUrl`) → `GET /render/:id` polled with backoff (2 s → 15 s) → `POST /thumb` for the poster → `DELETE /render/:id`. The container builds the filter graph (`containers/ffmpeg/src/graph.ts`: trims, `setpts`/`atempo` speed, reverse, scale/pad, transforms through `overlay`, fades, `xfade` dissolves, ASS captions, per-track `amix`, `sidechaincompress` ducking, keyframed gain) and writes H.264/AAC MP4 with `+faststart`. All renders run in one named container instance (`export`). Tests replace it with `setRendererForTests`; `MEDIA_CONTAINER=off` fails exports with `renderer_unavailable`. Local `wrangler dev`: the container must reach the signed media URLs, i.e. `PRIVATE_MEDIA_BASE_URL`/`PUBLIC_APP_URL` must be reachable from Docker.

## Sharing

Share settings: `audience` (`link` = anyone with the link, default; `workspace` = signed-in members of the project's workspace), `allowDownload` (false), `showPrompt` (true; prompt fields — any `params` key containing "prompt" — are left out of the snapshot and the read when false), `showOnProfile` (false; "Publish to profile": the share's cover — first video, else first image — appears on the author's public profile when it is rated safe).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/:id/share` | Any member → `{ enabled, shareId, url, snapshotAt, audience, allowDownload, showPrompt, showOnProfile }`; without an active link `enabled: false`, `shareId`/`url`/`snapshotAt` null and the default settings |
| POST | `/api/projects/:id/share` | Editor+. Any subset of the settings → `201 { shareId, url, apiUrl, createdAt, audience, allowDownload, showPrompt, showOnProfile }`. Writes a JSON snapshot of the graph to R2 (`shares/<shareId>.json`). Re-sharing refreshes the snapshot (re-publish) and keeps the same link; settings not given keep their current values. `url` is `<PUBLIC_APP_URL>/share/<shareId>` (SPA route) |
| PATCH | `/api/projects/:id/share` | Editor+. Settings toggles without re-publishing (same `snapshotAt`) → the `GET` shape. `404` without an active link; empty body → `400`. Turning `showPrompt` on takes effect at the next publish (the current snapshot has no prompts); turning it off hides them at once |
| DELETE | `/api/projects/:id/share` | revokes the project's links and deletes their snapshots → `{ ok, revoked }` |
| GET | `/api/share/:shareId` | `link`: public, no auth; `workspace`: only signed-in members of the project's workspace (others `404`) → `{ shareId, title, revision, createdAt, allowDownload, audience, showPrompt, nodes: [{ id, kind, title, params, position, groupId, media: { kind, url, thumbUrl, downloadUrl } \| null }], edges, groups }`; `404` when missing or revoked. URLs are signed for 1 h at read time; `downloadUrl` only when downloads are allowed |

D-005: a share never includes mature outputs. At share time nodes are dropped (with their edges) when their output asset is mature, their model is mature, `params.mature` is true, or an asset node references a mature asset; mature and foreign asset ids are scrubbed from the remaining params. At read time every asset is re-checked and newly mature ones lose their media.
