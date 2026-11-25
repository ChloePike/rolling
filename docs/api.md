# API

JSON over HTTPS under `/api`, served by the Hono Worker. Auth by session cookie. Every write takes and returns a `revision` where noted; a stale revision returns `409 CONFLICT` with the current state. Errors: `{ "error": { "code": "…", "message": "…", "data": {} } }`.

Payment-related error codes the UI must handle:
- `NO_PLAN` → open Paywall `variant=join`, keep the pending action.
- `INSUFFICIENT_CREDITS` (`data: { needed, balance }`) → Paywall `variant=credits`.
- `QUOTE_EXPIRED` → re-quote and show the new total.
- `MEMBER_LIMIT_REACHED` → tell the user their team limit for the month is used.
- `CONCURRENCY_LIMIT` (`data: { limit, active, requested }`) → too many jobs running for the plan; wait or upgrade.

## Auth (M1)

Better Auth on D1, mounted at `/api/auth/*`. The session cookie is `__Secure-rolling.session_token` on https (`rolling.session_token` on `http://localhost`): `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days, sliding (refreshed once a day of use; the refreshed cookie comes back on any `/api` response). Sessions are rows in D1 (`sessions`). Better Auth checks `Origin` on cookie-bearing POSTs: send requests from the app origin (`PUBLIC_APP_URL`). Errors use the envelope; Better Auth's own code is in `data.authCode`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/providers` | `{ emailCode: true, google: boolean, apple: boolean }` (social methods only when configured) |
| POST | `/api/auth/email-otp/send-verification-otp` | `{ email, type: "sign-in" }` → `{ success: true }`. Emails a 6-digit code valid 10 minutes (new and existing users alike). `429 RATE_LIMITED` with `data.retryAfter` (seconds): 30 s resend cooldown per address; 5 requests per minute per email + IP (`retryAfter: 60`) |
| POST | `/api/auth/sign-in/email-otp` | `{ email, otp }` → `{ token, user }` and the session cookie. Creates the user on first sign-in (sign-up: personal workspace, owner membership, prefs from `Accept-Language`). Errors: `400 INVALID_CODE`, `400 CODE_EXPIRED`, `429 TOO_MANY_ATTEMPTS` (5 wrong tries; ask for a new code), `429 RATE_LIMITED` (5 tries per minute per email + IP), `400 VALIDATION_FAILED` (code not 6 digits) |
| POST | `/api/auth/sign-in/social` | `{ provider: "google" \| "apple", callbackURL, errorCallbackURL?, newUserCallbackURL? }` → `{ url, redirect: true }`; navigate the window to `url`. Callback URLs are app paths (e.g. `/home`) |
| GET/POST | `/api/auth/callback/:provider` | OAuth return (Apple posts a form). Sets the session cookie and redirects (302) to `callbackURL`; on failure redirects to `errorCallbackURL` (default `/api/auth/error`) with `?error=<code>` |
| GET | `/api/auth/get-session` | Better Auth session read (`{ session, user }` or `null`); prefer `/api/me` |
| POST | `/api/auth/logout` | Ends the session (D1 row deleted, cookie cleared) → `{ ok: true }`; always 200 |

Signed-out callers of member routes get `401 UNAUTHENTICATED`. The current workspace is the `x-workspace-id` header (WebSocket upgrades: `?workspaceId=`), validated against membership (`403 FORBIDDEN`, malformed `400 BAD_REQUEST`); without it, the user's personal workspace. Every `/api` route sees the same context `{ userId, workspaceId, role, plan, isMember, matureAllowed, prefs, memberships }` (REST, GraphQL context `auth`, WebSockets). In `ENVIRONMENT=development` only (local dev, tests), the `x-dev-user: <id>` header (or `?devUser=`) stands in for a session.

## Account
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | See shape below. `private, no-store` |
| PATCH | `/api/me/prefs` | Any subset of `{ language, currency, creationMode, defaultRatio, defaultModel, confirmThreshold, notifications, theme, matureContent }` → `{ prefs, matureAllowed }`. Unknown keys or an empty body → `400 VALIDATION_FAILED`. `matureContent: true` without an active plan → `402 NO_PLAN`. Pushes `prefs.changed { prefs }` to the user's sockets |

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

- `plan` when the workspace has an active plan (subscription `active`/`trialing`, period not over): `{ id: "starter"|"plus"|"pro", label, interval: "month"|"year", status, currentPeriodEnd, cancelAtPeriodEnd, perks: { monthlyCredits, topUpBonus, concurrentJobs, maxVideoResolution, maxImageResolution, voiceCloning, seats } }` (perks from `PLANS`, D-006).
- `isMember` = active plan (D-007). `matureAllowed` = member && `prefs.matureContent` && `workspace.matureAllowed` (D-005).
- `balance` from `CreditAccount.balance()`; zeros until that RPC is available.
- Prefs values: `language` ∈ en, ja, zh-TW, zh-HK, ko, id, th, vi, es, pt-BR, de, fr; `currency` ∈ USD, EUR, GBP, JPY, TWD, HKD, KRW, IDR, THB, VND, BRL; `creationMode` ∈ simple, advanced; `defaultRatio` ∈ 16:9, 9:16, 1:1, 4:5, 21:9; `theme` ∈ system, light, dark (D-010); `confirmThreshold` integer 0–100000 credits (0 = always confirm); `notifications` partial `{ done, low, renewal, product }` booleans, merged. Sign-up defaults: language and currency from `Accept-Language` (unsupported → en / USD), the rest as shown above.

WebSocket `/api/ws` (UserHub) needs a session (`401` otherwise). Server messages include `hello`, `prefs.changed { prefs }`, `credits.changed`, `activity.updated`, `notification`.

## Account and billing

M2. All amounts in credits are integers (1 credit = $0.01 retail, D-006); money is in USD cents. Times are epoch ms. Billing reads use the auth context (current workspace, `x-workspace-id`).

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/billing/plans` | public | Plans, top-up rules and `current` (below) |
| GET | `/api/billing` | any member | Billing summary (below) |
| POST | `/api/billing/checkout` | owner (plan), editor (topUp) | Body below → `{ url, sessionId, credits? }`; redirect the window to `url` |
| GET | `/api/billing/checkout/:sessionId` | any member | Outcome for the return page (below) |
| POST | `/api/billing/portal` | owner | `{ returnTo? }` → `{ url }` (Stripe customer portal: card, plan change, cancel, invoices). No Stripe customer yet → `402 NO_PLAN` |
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
              "topUpBonus": 0.05, "concurrentJobs": 5, "maxVideoResolution": "1080p", "maxImageResolution": "2K", "voiceCloning": true, "seats": 1 }],
  "topUp": { "minCents": 1000, "maxCents": 1000000, "tiers": [{ "minCents": 1000, "bonus": 0 }, { "minCents": 2500, "bonus": 0.04 }, { "minCents": 5000, "bonus": 0.1 }, { "minCents": 10000, "bonus": 0.15 }], "presetsCents": [1000, 2500, 5000, 10000, 25000] },
  "autoTopUp": { "thresholdCredits": 200, "amountCents": 1000 },
  "current": { "plan": "plus", "isMember": true }
}
```
`current` is `null` when signed out. Top-up credits for an amount: `quoteTopUp(amountCents, plan)` in `@rolling/core/pricing/config` (the client may use it for the live preview; the server recomputes).

`GET /api/billing` (same as GraphQL `billing`):

```json
{ "plan": "plus", "interval": "month", "status": "active", "renewsAt": 1767225600000, "cancelAtPeriodEnd": false, "periodEnd": 1767225600000,
  "balance": { "plan": 453, "purchased": 2725, "held": 0, "planExpiresAt": 1767225600000 },
  "autoTopUp": { "enabled": true, "thresholdCredits": 200, "amountCents": 1000 } }
```
`plan`/`interval` are `null` without a live subscription (`active`, `trialing` or `past_due` and period not over); `renewsAt` is `null` when the plan ends at period end. `balance.plan` and `balance.purchased` are available credits; `held` is reserved by running jobs. `autoTopUp` is `null` until set.

`POST /api/billing/checkout` body (Zod, discriminated by `kind`):

```ts
{ kind: "plan", planId: "starter" | "plus" | "pro", interval: "month" | "year", resume?: { runQuoteId: string }, returnTo?: string }
{ kind: "topUp", amountCents: number /* whole cents, 1000..1000000 */, resume?: { runQuoteId: string }, returnTo?: string }
```
- `returnTo` is an app path (default `/settings/billing`). Stripe returns to `<returnTo>?checkout=success&session_id=<id>` or `<returnTo>?checkout=canceled`.
- Plan: a workspace that already has a live plan → `409 CONFLICT` `data.reason = "already_subscribed"` (change plans in the portal). The Stripe price is found by lookup key `rolling_<plan>_<interval>`.
- Top-up: members only → `402 NO_PLAN`; amount out of range or not whole cents → `400 VALIDATION_FAILED` `data: { field: "amountCents", minCents, maxCents }`. Response includes `credits` (base + tier bonus + plan bonus). The card is saved for auto top-ups.
- Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (role), `503 INTERNAL` when Stripe is not configured.

`GET /api/billing/checkout/:sessionId` → `{ sessionId, kind: "plan" | "topUp", status: "open" | "complete" | "expired", planId, interval, amountCents, credits, completedAt, resume: { runQuoteId } | null }`. `complete` means the webhook has applied it (subscription stored / credits added); poll until then, then continue the pending run with `resume.runQuoteId` (re-quote on `QUOTE_EXPIRED`). Other workspaces' sessions → `404`.

`LedgerLine` (REST and GraphQL): `{ id, kind, bucket: "plan" | "purchased", amount, userId, runId, jobId, stripeRef, note, createdAt }`. `amount` is signed:

| kind | amount | meaning |
|---|---|---|
| `grant` | + plan | plan credits for a period (`note`: `<plan>:<interval>`) |
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
| `invoice.paid` | plan credits for the invoice period (`CreditAccount.grant`, leftover plan credits expire); paid upgrade mid-period grants the new plan; other plan changes update limits only; late invoices for older periods are ignored |
| `customer.subscription.created`, `.updated` | store status, plan, period, `cancel_at_period_end` |
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
All act on the current workspace (`x-workspace-id`, default personal). Seats per plan (D-006): Starter 1, Plus 1, Pro 10; members plus pending invites count.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/workspace/members` | Any member → `{ members: [{ userId, name, email, image, role, monthlyCreditLimit, isYou }], invites: [{ id, email, role, invitedBy, createdAt, expiresAt }] (owners only; others get []), seats: { used, limit } }` |
| POST | `/api/workspace/invites` | Owner. `{ email, role: "editor"\|"viewer" }` → `201 { invite }` and an email with the link `<PUBLIC_APP_URL>/invite/<token>` (valid 7 days). A new invite to the same address replaces the pending one. Errors: `402 NO_PLAN` (no plan), `403 SEAT_LIMIT_REACHED` (`data: { seats, used, requiredPlan: "pro" }`), `409 CONFLICT` (already a member), `403 FORBIDDEN` (not owner) |
| GET | `/api/workspace/invites/lookup?token=` | No session needed → `{ workspace: { id, name }, inviterName, email, role, expiresAt, state: "pending"\|"accepted"\|"revoked"\|"expired" }`; `404` unknown token. For the `/invite/:token` screen |
| POST | `/api/workspace/invites/accept` | Session required. `{ token }` → `{ workspace: { id, name, kind }, role }`. The signed-in email must match the invite (`403 FORBIDDEN`); used/expired/revoked → `409 CONFLICT` (`data.state`). Then switch with `x-workspace-id` |
| DELETE | `/api/workspace/invites/:id` | Owner; revokes a pending invite → `{ ok: true }` |
| PATCH | `/api/workspace/members/:userId` | Owner. `{ role?: "owner"\|"editor"\|"viewer", monthlyCreditLimit?: integer ≥ 0 \| null }` → `{ member: { userId, role, monthlyCreditLimit } }`. The last owner cannot step down (`409`) |
| DELETE | `/api/workspace/members/:userId` | Owner removes a member, or a member leaves (own id). Not the last owner, not your own personal workspace (`409`) → `{ ok: true }` |

Roles: owner (members, invites, limits, billing), editor (create and edit), viewer (read). Routes use `requireUser`, `requireMember` (`402 NO_PLAN`) and `requireRole(min)` (`403 FORBIDDEN`, `data: { required, role }`) from `apps/api/src/auth/context.ts`.

### Staging test inbox
With the var `EMAIL_PROVIDER=test-inbox` (refused in production) emails are stored in D1 for 24 h instead of sent. `GET /api/test/inbox?to=<email>&limit=10` with `authorization: Bearer <TEST_INBOX_TOKEN>` → `{ messages: [{ to, subject, text, code, template, sentAt }] }`, newest first; `401` bad token; `404` when the provider is not `test-inbox`.

## Projects and graph
| GET | `/api/projects` | recent first |
| POST | `/api/projects` | `{ title, fromTemplateId? }` |
| GET | `/api/projects/:id` | canvas, nodes, edges, revision |
| POST | `/api/projects/:id/patch` | `{ baseRevision, ops: GraphOp[] }` → `{ revision }` (same ops the agent proposes; also accepted over the WebSocket) |
| GET | `/api/projects/:id/ws` | WebSocket to ProjectRoom: snapshot, then `graph.patched`, `node.version`, `job.progress`, `job.done`, `job.failed`, `timeline.patched`, `credits.changed`, `proposal.created`, `agent.delta`; client sends patches `{ baseRevision, ops }` |
| GET | `/api/nodes/:id/versions` | history; `POST /api/nodes/:id/active` `{ versionId }` |

## Runs
| POST | `/api/runs/quote` | `{ projectId, scope: node|selection|all, nodeIds? }` or `{ promptSpec }` from a tool page → `{ quoteId, items: [{ nodeId, action: run|reuse|blocked|none, model, credits, reason? }], total, balanceAfter, expiresAt }` |
| POST | `/api/runs` | `{ quoteId }` → `{ runId }` or `NO_PLAN` / `INSUFFICIENT_CREDITS` |
| POST | `/api/runs/:id/cancel` | releases holds of unfinished items |
| GET | `/api/runs` | Activity list: filters status, project, model, date |

## Assets and libraries
| POST | `/api/assets/upload-url` | `{ filename, contentType, size }` → signed PUT URL + assetId |
| POST | `/api/assets/:id/complete` | triggers probe, thumbnail, waveform |
| GET | `/api/assets` | `?scope=mine|team|builtin|public|all&kind=&q=` (powers the `@` picker) |
| GET | `/api/public-library` | `?category=&sub=&q=` with license |
| GET/POST | `/api/characters`, `/api/voices` | voice clone: `POST /api/voices/clone` `{ sampleAssetId }` (async job) |
| GET | `/api/templates` | |

## Agent
| POST | `/api/agent/threads` | `{ projectId?, surface: home|canvas|editor|tool, skill? }` |
| POST | `/api/agent/threads/:id/messages` | `{ text, refs: assetIds[], selection?: nodeIds[] }` → streamed response (text/event-stream from the AgentSession DO) of `text`, `tool`, `proposal`; also mirrored on the project WebSocket |
| POST | `/api/agent/proposals/:id/apply` | applies as the user; returns new revision; for `plan` proposals `{ optionIndex }` creates nodes |
| POST | `/api/agent/proposals/:id/discard` | |

## Editor
| GET | `/api/canvases/:id/timeline` | EDL + revision (assembled on first open) |
| POST | `/api/canvases/:id/timeline/patch` | `{ baseRevision, ops: TimelineOp[] }` |
| POST | `/api/canvases/:id/timeline/reassemble` | rebuild from script, keeps manual trims where shots match |
| POST | `/api/canvases/:id/export` | `{ preset: mp4_1080p }` → ExportWorkflow; result on the project WebSocket |

## Sharing
| POST | `/api/projects/:id/share` | `{ allowDownload }` → snapshot link; `DELETE` to stop sharing |
