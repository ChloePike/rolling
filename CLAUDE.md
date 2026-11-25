# Rolling — build guide for Claude Code

Rolling (working name, rename pending) is an AI video studio for creators and small brand teams, sold globally, English first. It is a web app installable as a PWA. No native apps, no phone-specific layouts.

## Language (strict)

- **Everything in the repo is English**: code, identifiers, comments, commit messages, test names, docs, log messages, error messages. No Chinese (or any other language) in source files, except translated UI strings in `messages/<locale>.json`.
- Conversation with the user is in Chinese.

Read these before writing code, in this order:

0. `docs/decisions.md` — decisions made after the spec. **Where it disagrees with any other doc, it wins.**
1. `docs/PRD.md` — what the product does, scope, business rules (membership gate, credits).
2. `docs/design/handoff.md` — every screen, its states, tokens, components, interaction and copy rules.
3. `docs/architecture.md` — stack, services, data model, job pipeline, credit ledger, rendering.
4. `docs/harness.md` — the agent harness: loop, tools, approval gates, patch format, evals.
5. `docs/api.md` and `db/*.sql` (D1 + one file per Durable Object) — contracts to implement.
6. `docs/milestones.md` — the build order. Work milestone by milestone; each has acceptance checks.

Design source: `docs/design/screens/*.dc.html` are the approved screens (one file per artboard, `canvas.json` is the index). They use a small template syntax (`{{ value }}`, `<sc-for>`, `<sc-if>`, `<dc-import>`) and inline styles. Treat them as the visual and copy source of truth: match spacing, sizes, colors, copy and states. Rebuild them as React components; do not ship the `.dc.html` files.

## Stack (decided) — everything on Cloudflare

- **One Worker** (`apps/api`, Hono router) serves the API and the static frontend (Workers static assets).
- **Frontend** (`apps/web`): Vite + React + TypeScript SPA, TanStack Router + TanStack Query, built to static assets. No Next.js, no SSR.
- **Data**: D1 for global relational data (users, workspaces, projects index, assets catalog, runs index). Durable Objects with SQLite storage for state that needs strict ordering: `ProjectRoom` (one per project: graph, timeline, revisions, WebSocket fan-out), `CreditAccount` (one per workspace: ledger and balance, atomic holds), `AgentSession` (one per agent thread).
- **Media**: R2, with Cloudflare Images for image thumbnails.
- **Background work**: Cloudflare Workflows for each generation and export (durable steps, `waitForEvent` for provider webhooks, `sleep` for polling); Queues for fan-out (media processing, ledger mirroring, notifications).
- **FFmpeg**: Cloudflare Containers (`FfmpegRenderer`) for exports, probing, thumbnails and waveforms of uploaded video/audio.
- Drizzle ORM for D1 and DO SQLite. Zod for validation.
- Auth: Better Auth on D1 (Google, Apple, email one-time code).
- Payments: Stripe via its fetch client; webhook verification with `constructEventAsync`. Stripe is the only payment provider.
- Canvas: `@xyflow/react`. Timeline editor: custom, drawn on `<canvas>`.
- API style (D-003): REST for commands, WebSocket-first for live state (`ProjectRoom` per project, `UserHub` per user, hibernation API; agent streams over the socket), GraphQL Yoga at `/api/graphql` for read-only queries. No SSE, no Redis.
- i18n: `react-intl` (FormatJS, ICU messages). English is the source locale.
- PWA: `vite-plugin-pwa` (Workbox): precache, offline page, update prompt.
- Motion: CSS transitions; `motion` (motion.dev) only where layout animation is needed.
- Models (D-002): **Hyperouter** (`https://api.hyperouter.app/v1`) is the single gateway for the agent LLM (`deepseek/deepseek-v4.1-flash`), images and video, behind our own `LlmProvider` / `GenerationProvider` interfaces. Webhooks use Standard Webhooks signing. Key in the `HYPEROUTER_API_KEY` secret.
- Public library (D-004): imported from PoseWear (https://posewear.pages.dev/) into R2 + D1 with per-item license labels.
- Observability: Workers Logs + traces, `@sentry/cloudflare`, Analytics Engine for product metrics.
- Tooling: pnpm workspaces, wrangler, Vitest with `@cloudflare/vitest-pool-workers`, Playwright for flows.

Repo: `apps/api` (Worker + DO classes + Workflows), `apps/web` (SPA), `containers/ffmpeg` (Dockerfile + tiny HTTP server), `packages/core` (domain logic, pure TS, runs in Workers), `packages/agent`, `packages/db` (Drizzle schemas for D1 and each DO), `packages/ui`.

## Non-negotiable rules

- Credits are money. Every charge goes through the `CreditAccount` Durable Object (quote → hold → settle or release). Never change a balance anywhere else. Every provider call carries an idempotency key.
- Nothing that costs credits runs without the user’s approval in the UI, except runs below the user’s “Confirm before running” threshold (default 20 credits). The agent can propose; only the user (or that threshold) can spend.
- Non-members can sign up, browse, and plan with the agent for free. Generating requires an active plan. Credit packs are sold only to members.
- All UI strings live in `messages/en/<feature>.json` (ICU, keys prefixed by feature, merged at build). No string concatenation for sentences; use placeholders and plural rules. Dates, numbers and currency go through `Intl`.
- Visual style: neutral dark, one blue accent (`#3B82F6`) for UI state, brand yellow (`#FFCB2B`) only for the logo, app icon and splash. No gradients, no glow, no emoji in UI, no decorative motion. Follow `docs/design/handoff.md` → Copy rules: short, specific, sentence case, no “AI magic” language.
- Respect `prefers-reduced-motion`.
- Keep provider-specific code inside `packages/core/models/providers/*`. The rest of the app talks to the model gateway only.
- 18+ content (D-005) is allowed only for workspaces with an active paid plan (payment is the age gate; no DOB check) whose user turned on the mature-content preference. Never generate or allow sexual content involving minors or anyone who appears to be one, or sexual/intimate content depicting a real, identifiable person. These checks live in `packages/core/safety` and cannot be disabled by any setting. Mature outputs never appear on public surfaces.

## Conventions

- TypeScript strict. Zod for every API input and every tool input the agent can call.
- All server logic is Hono routes under `/api` in the Worker; keep handlers thin and put logic in `packages/core`.
- Mind Workers limits: no long work in a request (use a Workflow), no Node-only libraries (check `nodejs_compat` support first).
- IDs are prefixed ULIDs (`prj_`, `node_`, `run_`, `job_`, `ast_`, `led_`).
- Tests: Vitest for units, Playwright for the flows listed in each milestone’s acceptance checks.
- Commit per milestone step; D1 migrations via wrangler in `packages/db/migrations/d1`; DO SQLite schemas migrate in the object constructor (`blockConcurrencyWhile`).

## Open decisions (use the placeholder, don’t invent)

Product name and domain, avatar / TTS / voice-clone provider (not on Hyperouter), Stripe acceptance of adult content, plan prices, credits per plan, credit pack prices, yearly discount, per-model credit prices. Use the values in `packages/core/pricing/config.ts`, which ships with the placeholders listed in `docs/PRD.md` → Open decisions.
