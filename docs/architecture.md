# Architecture — Cloudflare only

## 1. Overview

```
Browser: React SPA (Vite) + service worker (PWA)
   │  HTTPS /api/*            one WebSocket /api/ws per browser (SharedWorker; D-014)
   │  uploads: PUT parts straight to R2 (presigned UploadPart, D-011)
   │  media:   media domain (public CDN bucket + signed private URLs, D-008)
   ▼
Worker  apps/api  (Hono)  ── also serves the SPA from static assets
   │
   ├── D1                      users, auth, workspaces, members, subscriptions, prefs,
   │                           projects index, assets catalog, public library, templates,
   │                           runs/jobs index (Activity), ledger mirror (read model)
   ├── Durable Objects (SQLite)
   │     ProjectRoom   (1 per project)    graph, node versions (+ content rating), timeline EDL, revisions, event ring, fan-out to subscribed UserHubs
   │     UserHub       (1 per user)       the WebSocket gateway: user channel + project subscriptions; agent abuse limit
   │     CreditAccount (1 per workspace)  ledger + balance, atomic quote/hold/settle/release, member limits, agent allowance holds (D-012)
   │     AgentSession  (1 per thread)     messages, proposals, streaming turn state
   ├── Workflows
   │     GenerateWorkflow   one per job: submit → wait (webhook event or poll) → store → settle/release → notify
   │     ExportWorkflow     timeline → Container FFmpeg → R2 → notify
   │     BillingWorkflow    period grants, expiries, auto top-up
   ├── Queues          media.process, ledger.mirror, notify.email
   ├── Containers      FfmpegRenderer: export MP4, probe, video thumbnails, audio waveforms
   ├── R2 (+ Images)   rolling-media-<env> (private: uploads, generated media, exports, thumbnails), rolling-public-<env> (public library)
   └── Analytics Engine, Workers Logs, Sentry
   ▼
External: DeepSeek, Seedance/Seedream, MiniMax, Wan (Alibaba Cloud Model Studio), Stripe, email provider
```

Why this split:
- **ProjectRoom** serializes all edits to one project (graph patches, agent applies, job results), so revisions never race, and pushes every event to the UserHubs subscribed to it; each **UserHub** forwards to that user's sockets (D-014). Both use hibernating WebSockets.
- **CreditAccount** serializes every balance change for a workspace. A hold either succeeds or fails atomically; no double spend across tabs, team members, or retries.
- **Workflows** give each provider job durable retries and a clean place to wait minutes for a video without holding a request open.
- **D1** holds what needs cross-project queries (lists, search, Activity, the `@` picker). DOs mirror summaries into D1 through the `ledger.mirror` queue and direct writes after commits.
- **Containers** run FFmpeg, which Workers cannot.

## 2. Repository

```
apps/api/
  src/index.ts           Hono app, route modules, static assets fallback to SPA
  src/routes/*           auth, me, billing, stripe-webhook, projects, runs, assets, library, agent, timeline, share, provider-webhooks
  src/do/ProjectRoom.ts  src/do/CreditAccount.ts  src/do/AgentSession.ts
  src/workflows/Generate.ts  Export.ts  Billing.ts
  src/queues/*.ts
  wrangler.jsonc         bindings: DB (D1), MEDIA (R2), IMAGES, PROJECT, CREDITS, AGENT (DO), GENERATE/EXPORT/BILLING (Workflows), QUEUES, FFMPEG (Container), RATE_LIMIT, AE
apps/web/                Vite + React SPA
containers/ffmpeg/       Dockerfile (ffmpeg + small HTTP server: /render, /probe, /thumb, /waveform)
packages/core/           pure TS: graph (types, validate, staleness, plan, layout), pricing, credits math, timeline (EDL, assemble, ops), models (gateway, capabilities, providers/*)
packages/agent/          harness, tools, prompts, skills, evals
packages/db/             drizzle: d1/schema.ts, do/project.ts, do/credits.ts, do/agent.ts, migrations/d1
packages/ui/             tokens.css + primitives
messages/                en.json (+ locales)
```

## 3. Frontend

- Vite + React + TypeScript, TanStack Router (file routes), TanStack Query for `/api` data.
- One WebSocket per browser (D-014): a `SharedWorker` holds `wss://…/api/ws` for every tab. The project screen sends `subscribe { channel: 'project', projectId, lastRevision? }` and gets a snapshot (or the missed events), then project events (`graph.patched`, `node.version`, `job.*`, `timeline.patched`, `proposal.*`, `agent.*`). Local edits are sent as `patch { projectId, baseRevision, ops }`; the gateway answers `ack { revision }` or `conflict { snapshot }`. User-channel events (`credits.changed`, `prefs.changed`, `activity.updated`, `agent.allowance`, `notification`) reach every tab. Refused connections close with 4401/4403/4404 after an `error` message. `/api/projects/:id/ws` is deprecated.
- Canvas with `@xyflow/react`; timeline on `<canvas>`; preview plays the EDL with `<video>` elements and WebAudio.
- `react-intl` with ICU messages; locale from prefs → browser → `en`; one CJK font loaded per locale.
- `vite-plugin-pwa`: precache app shell, runtime cache thumbnails, offline fallback route, prompt-to-reload (never while a job runs or the editor is open).

## 4. Data placement

| Data | Where | Notes |
|---|---|---|
| users, sessions, accounts | D1 | Better Auth D1 adapter |
| workspaces, members (role, monthly limit), prefs | D1 | |
| subscriptions (Stripe mirror) | D1 | written by webhook route |
| projects index (title, updated, thumbnail, owner) | D1 | updated by ProjectRoom after commits |
| graph: canvases, nodes, edges, node_versions (with `rating`) | ProjectRoom SQLite | source of truth |
| gateway subscribers, event ring (500), agent threads with pending proposals | ProjectRoom SQLite | D-014 fan-out and catch-up; eager proposal rebase |
| timeline EDL + revision | ProjectRoom SQLite | |
| ledger + balances | CreditAccount SQLite | source of truth |
| ledger mirror | D1 `ledger_lines` | for Activity and invoices; eventually consistent |
| quotes, runs, jobs | D1 (index) + Workflow state | job status also pushed to ProjectRoom |
| assets catalog, public library, characters, voices, templates | D1 | files in R2 |
| agent threads, messages, proposals | AgentSession SQLite | proposal summaries mirrored to D1 |
| agent allowance holds | CreditAccount SQLite | D-012; per-turn history in D1 `agent_usage` |
| share snapshots | R2 (JSON) + D1 row | |

DDL: `db/d1.sql`, `db/do-project.sql`, `db/do-credits.sql`, `db/do-agent.sql` (SQLite dialect).

## 5. Credits and billing

CreditAccount DO methods (RPC):

| Method | Effect |
|---|---|
| `quote(items)` | prices items, stores quote (10 min) and returns total + balance after |
| `hold(quoteId, runId, userId)` | checks member monthly limit; reserves total from plan bucket first, then purchased; `INSUFFICIENT_CREDITS` if short |
| `settle(jobId, actual)` | spends ≤ held for that job, releases the rest |
| `release(jobId, reason)` | returns the job’s hold; writes a refund line |
| `grant(period)` | on `invoice.paid`: expire leftover plan credits, grant the new amount, set expiry |
| `purchase(amount, ref)` | on pack checkout |
| `expire()` | DO alarm at period end |
| `balance()` | `{ plan, purchased, held, planExpiresAt }` |

Every mutating call takes an idempotency key; repeats return the first result. After each commit the DO enqueues a `ledger.mirror` message and, if below the auto top-up threshold, starts `BillingWorkflow` for an off-session Stripe payment.

Stripe: Checkout for plans and packs (`resume` metadata carries the pending quote so the run continues after payment), customer portal for card changes and cancellation, webhooks verified with `constructEventAsync` and processed idempotently by event id.

## 6. Generation

1. `POST /api/runs/quote` → ProjectRoom builds the plan (run / reuse / blocked / none) from the graph; CreditAccount prices it.
2. User confirms (or under-threshold auto-confirm) → `POST /api/runs` → membership check (`NO_PLAN`) → `CreditAccount.hold` (`INSUFFICIENT_CREDITS`) → one `GenerateWorkflow` per runnable item, dependents started when inputs land.
3. `GenerateWorkflow` steps:
   - `prepare`: resolve inputs to signed R2 URLs, map params through the provider adapter.
   - `submit`: provider call with idempotency key → `externalId`.
   - `wait`: `step.waitForEvent('provider-done', timeout)` fed by `/api/hooks/:provider`; if the provider has no webhooks, loop `step.sleep` + `status()` with backoff.
   - `store`: copy output to R2, image thumbnails via Images, video thumbnail via Container; register asset in D1.
   - `commit`: `ProjectRoom.addVersion(nodeId, assetId, inputDigest)` (broadcasts), `CreditAccount.settle`.
   - on failure at any step: `CreditAccount.release`, `ProjectRoom.markFailed` with “refunded N credits”.
4. Auto model: `core/models/capabilities` picks the cheapest model that fits; on provider failure the workflow retries once on the next model in the fallback list under the same hold.

Concurrency per workspace (plan entitlement) is enforced in CreditAccount (count of held jobs).

## 7. Model gateway

```ts
interface GenerationProvider {
  id: string                                   // 'seedance-2.5'
  kind: 'video' | 'image' | 'avatar' | 'speech'
  capabilities: ModelCapabilities
  submit(req: GenerateRequest, key: string): Promise<{ externalId: string }>
  status(externalId: string): Promise<JobStatus>
  verifyWebhook?(req: Request): Promise<{ externalId: string, status: JobStatus } | null>
}
interface LlmProvider { chat(req: ChatRequest): AsyncIterable<ChatEvent> }   // streaming, tools
```
Fetch-only implementations (no Node SDKs unless they run on Workers). Keys in Worker secrets. Per-provider rate limits with the Rate Limiting binding. Confirm current endpoints, model IDs and webhook support for each provider when implementing; keep them in `providers/<name>.config.ts`.

## 8. Editor and export

EDL format, assemble and ops are in `packages/core/timeline` and are shared by the browser, ProjectRoom and the agent (see `docs/harness.md` for ops).

```json
{ "fps": 24, "width": 1080, "height": 1920,
  "tracks": [
    { "id": "C1", "kind": "caption", "clips": [{ "id": "c1", "start": 0.4, "end": 4.0, "text": "Morning. The first sip of the mountains." }] },
    { "id": "V1", "kind": "video", "clips": [{ "id": "v1", "assetId": "ast_…", "nodeId": "node_…", "in": 0, "out": 4, "start": 0, "transitionOut": { "type": "dissolve", "dur": 0.25 } }] },
    { "id": "A1", "kind": "voice", "clips": [{ "id": "a1", "assetId": "ast_…", "in": 0, "out": 8, "start": 0.4, "gainDb": 0 }] },
    { "id": "A2", "kind": "music", "clips": [{ "id": "m1", "assetId": "ast_…", "in": 0, "out": 12, "start": 0, "gainDb": -6, "duckUnder": ["A1"] }] } ] }
```
Export: `ExportWorkflow` sends the EDL and signed input URLs to `FfmpegRenderer` (Container), which builds the filter graph (scale/pad, xfade, ASS subtitles, amix with sidechain ducking), writes MP4 H.264/AAC 1080p straight to R2 via a presigned PUT, and returns metadata. The Worker never touches the bytes.

Uploads (D-011): the browser uploads straight to R2 as an S3 multipart upload — `POST /api/assets/uploads` creates it (8 MiB parts, resumable by fingerprint), `…/part-urls` returns presigned `UploadPart` URLs (~1 h), the client `PUT`s parts from one shared transfer queue and `…/complete` finishes it; the Worker never carries upload bytes. Then the `media.process` queue makes the image thumbnail (Images) or calls the Container for probe, poster frame and waveform peaks (JSON in R2), and rates the media (safety, below). When the Container is down, the asset is `ready` with `processing: pending` and the 5-minute cron re-queues it once the Container answers.

Media serving (D-008): images and video never stream through the API in production. Public-library items live in the public bucket behind the CDN (`PUBLIC_MEDIA_BASE_URL`); everything private is served by short-lived HMAC-signed URLs (`/media/<key>?exp=&ws=&sig=`, moving to the media hostname once the product domain exists), signed only for viewers allowed to see them (mature outputs, D-005).

## 9. Agent runtime

`AgentSession` DO per thread: stores messages and proposals, runs the turn (LLM stream + tools), streams events through ProjectRoom (canvas/editor threads) or UserHub (Home/tool threads) to the global socket. Threads with pending patch proposals register with their ProjectRoom, which calls `onRevision` after commits so proposals rebase (or go stale) at once.

Agent allowance (D-012): members only; each plan includes a monthly USD allowance of gateway cost. A turn holds its estimate in CreditAccount before the first LLM call and settles its actual `usage.cost` after (`429 AGENT_ALLOWANCE_EXHAUSTED` when it does not fit). The DeepSeek public LLMs are unmetered — no hold, cost still recorded in `agent_usage` — and limited to 300 turns per user per rolling hour in UserHub (`429 RATE_LIMITED`). Tools call ProjectRoom/CreditAccount/D1 read methods; propose tools write proposals only. Applying a proposal is `POST /api/agent/proposals/:id/apply`, which calls `ProjectRoom.applyPatch` as the user. The Cloudflare Agents SDK can be used for the DO plumbing (persisted chat, tool approval); keep our own tool and proposal types either way. Details in `docs/harness.md`.

## 10. Safety (D-005)

`packages/core/safety` + `apps/api/src/safety`, never configurable: deterministic multilingual rules first, then a DeepSeek text classifier for the hard limits (minors, real identifiable people in sexual content, and other non-negotiable categories); on mature runs a vision model rates image references and face detection checks uploaded photographs. Generation pre-checks in `prepare` and post-checks outputs in `store` (blocked outputs are deleted, the hold released). Every output and upload gets a rating `safe | suggestive | explicit` (`assets.rating`, `mature`; versions keep it in `node_versions.rating`); suggestive/explicit media never appear on share links, public surfaces or project thumbnails. Uploads are rated by the `media.process` consumer. Agent briefs and proposals go through `SafetyGate`. Events in D1 `safety_events` + Analytics Engine; repeated hard-limit blocks flag the workspace.

## 11. Security

Every route resolves `{ userId, workspaceId, role }` once; ProjectRoom and CreditAccount check them on each call. R2 access only through short-lived signed URLs. Share links serve an R2 snapshot read-only, downloads off by default. Stripe and provider webhooks verified. Rate limits on quote, run, agent and upload routes.

## 12. Observability

Workers Logs and traces across Worker → DO → Workflow → Container. Sentry (`@sentry/cloudflare`). Analytics Engine events: job latency and failures per model, refund rate, hold/settle drift, agent tokens per turn, proposal acceptance, cost per exported video. Crons (`apps/api/src/scheduled.ts`): every 6 h model sync and expired-upload cleanup; every 5 min the safety net (re-advance runs whose items waited on `CONCURRENCY_LIMIT` > 2 min, re-queue uploads left `processing: pending`); nightly 03:17 UTC ledger reconcile (CreditAccount `audit` vs the D1 `ledger_lines` mirror for workspaces touched in the last day; mismatches logged and sent to Analytics Engine as `ledger_reconcile`). Monthly: `pnpm --filter @rolling/api margin:report -- --month YYYY-MM --env production` prints gross margin per plan and flags < 50% (Team < 60%).

## 13. Environments

`wrangler.jsonc` environments: `dev` (local with `wrangler dev`, Stripe test, cheap models), `staging`, `production`. Secrets via `wrangler secret`. D1 migrations with `wrangler d1 migrations apply`.

## 14. Limits to design around

- No long work in a request: anything over a few seconds is a Workflow or a queue job.
- A DO handles one request at a time; keep ProjectRoom calls short (no provider calls inside it).
- Worker bundle size: keep the SPA in static assets, not in the Worker bundle.
- Libraries must run on Workers (`nodejs_compat` covers many Node APIs; check before adding a dependency).
