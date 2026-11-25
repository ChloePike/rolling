# Architecture — Cloudflare only

## 1. Overview

```
Browser: React SPA (Vite) + service worker (PWA)
   │  HTTPS /api/*            WebSocket /api/projects/:id/ws
   ▼
Worker  apps/api  (Hono)  ── also serves the SPA from static assets
   │
   ├── D1                      users, auth, workspaces, members, subscriptions, prefs,
   │                           projects index, assets catalog, public library, templates,
   │                           runs/jobs index (Activity), ledger mirror (read model)
   ├── Durable Objects (SQLite)
   │     ProjectRoom   (1 per project)    graph, node versions, timeline EDL, revisions, WebSocket fan-out
   │     CreditAccount (1 per workspace)  ledger + balance, atomic quote/hold/settle/release, member limits
   │     AgentSession  (1 per thread)     messages, proposals, streaming turn state
   ├── Workflows
   │     GenerateWorkflow   one per job: submit → wait (webhook event or poll) → store → settle/release → notify
   │     ExportWorkflow     timeline → Container FFmpeg → R2 → notify
   │     BillingWorkflow    period grants, expiries, auto top-up
   ├── Queues          media.process, ledger.mirror, notify.email
   ├── Containers      FfmpegRenderer: export MP4, probe, video thumbnails, audio waveforms
   ├── R2 (+ Images)   uploads, generated media, exports, thumbnails
   └── Analytics Engine, Workers Logs, Sentry
   ▼
External: DeepSeek, Seedance/Seedream, MiniMax, Wan (Alibaba Cloud Model Studio), Stripe, email provider
```

Why this split:
- **ProjectRoom** serializes all edits to one project (graph patches, agent applies, job results), so revisions never race, and pushes changes to every open tab over hibernating WebSockets.
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
- Project screen opens `wss://…/api/projects/:id/ws`; the socket carries the initial snapshot, then patches (`graph.patched`, `node.version`, `job.progress`, `job.done`, `job.failed`, `timeline.patched`, `credits.changed`, `proposal.created`). Local edits are sent as patches with `baseRevision`; ProjectRoom answers `ok {revision}` or `conflict {snapshot}`.
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
| graph: canvases, nodes, edges, node_versions | ProjectRoom SQLite | source of truth |
| timeline EDL + revision | ProjectRoom SQLite | |
| ledger + balances | CreditAccount SQLite | source of truth |
| ledger mirror | D1 `ledger_lines` | for Activity and invoices; eventually consistent |
| quotes, runs, jobs | D1 (index) + Workflow state | job status also pushed to ProjectRoom |
| assets catalog, public library, characters, voices, templates | D1 | files in R2 |
| agent threads, messages, proposals | AgentSession SQLite | proposal summaries mirrored to D1 |
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

Uploads: browser PUTs to R2 with a presigned URL; `media.process` queue calls the Container for probe, poster frame and waveform peaks (JSON in R2).

## 9. Agent runtime

`AgentSession` DO per thread: stores messages and proposals, runs the turn (LLM stream + tools), streams events to the browser over the project WebSocket (or its own socket on Home). Tools call ProjectRoom/CreditAccount/D1 read methods; propose tools write proposals only. Applying a proposal is `POST /api/agent/proposals/:id/apply`, which calls `ProjectRoom.applyPatch` as the user. The Cloudflare Agents SDK can be used for the DO plumbing (persisted chat, tool approval); keep our own tool and proposal types either way. Details in `docs/harness.md`.

## 10. Security

Every route resolves `{ userId, workspaceId, role }` once; ProjectRoom and CreditAccount check them on each call. R2 access only through short-lived signed URLs. Share links serve an R2 snapshot read-only, downloads off by default. Stripe and provider webhooks verified. Rate limits on quote, run, agent and upload routes.

## 11. Observability

Workers Logs and traces across Worker → DO → Workflow → Container. Sentry (`@sentry/cloudflare`). Analytics Engine events: job latency and failures per model, refund rate, hold/settle drift, agent tokens per turn, proposal acceptance, cost per exported video. Nightly cron: reconcile CreditAccount totals with the D1 mirror; alert on mismatch or on two settles for one job.

## 12. Environments

`wrangler.jsonc` environments: `dev` (local with `wrangler dev`, Stripe test, cheap models), `staging`, `production`. Secrets via `wrangler secret`. D1 migrations with `wrangler d1 migrations apply`.

## 13. Limits to design around

- No long work in a request: anything over a few seconds is a Workflow or a queue job.
- A DO handles one request at a time; keep ProjectRoom calls short (no provider calls inside it).
- Worker bundle size: keep the SPA in static assets, not in the Worker bundle.
- Libraries must run on Workers (`nodejs_compat` covers many Node APIs; check before adding a dependency).
