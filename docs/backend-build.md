# Backend build rules (parallel milestone work)

Applies to every agent building server features. Read `CLAUDE.md`, `docs/decisions.md` (wins over other docs), `docs/architecture.md`, `docs/api.md`, `docs/harness.md` and `db/*.sql` first. English only in code and comments.

## Ownership and shared files

- Each agent owns its route modules (`apps/api/src/routes/<area>.ts`), Durable Object (`apps/api/src/do/<Name>.ts`), workflows/queues it is assigned, and `packages/core/src/<area>/**`.
- **D1 migrations are numbered per agent to avoid collisions:** auth `0004_*.sql`, billing `0005_*.sql`, projects/assets `0006_*.sql`. Later milestones take the next free number. Update `packages/db/src/d1/schema.ts` only in the table blocks you own (re-read the file right before editing; others edit it too) and extend `packages/db/test/schema.test.ts`'s migration list.
- Shared entry files (`apps/api/src/index.ts`, `apps/api/src/graphql/index.ts`, `apps/api/wrangler.jsonc`, `apps/api/src/env.ts`): make minimal additive edits (mount your route, add your binding/secret), re-read right before editing.
- `packages/core/src/{graph,timeline}` are being edited by the canvas frontend agent; read them, don’t restructure them. `apps/web/**` belongs to the frontend agents — don’t edit it. Document the exact request/response contract you implement so the frontend can swap its `api.ts` mocks later.

## Contracts

- REST commands under `/api` (Hono + Zod, error envelope `{error:{code,message,data}}`, codes from `apps/api/src/lib/errors.ts`); realtime through the WebSocket envelope in `@rolling/core/graph`; read-heavy lists through GraphQL (read-only). Keep `docs/api.md` in sync for your area (edit only your section).
- Auth context: every route resolves `{ userId, workspaceId, role, plan }` once via one middleware (auth agent provides it; until it lands, use `getSessionUser` and the dev header in `ENVIRONMENT=development`).
- Money: credits only change inside `CreditAccount` (quote → hold → settle | release; grant, purchase, expire). Idempotency keys on every mutation and every provider call.
- D-005 (mature), D-006 (pricing, plan caps), D-007 (members-only agent and generation: `NO_PLAN`), D-008 (media domain, signed URLs) apply.
- Secrets (Stripe, email provider, OAuth clients) are Worker secrets; in tests use fakes. Never log secret values or full tokens.

## Testing

- Vitest in the workers pool (`@cloudflare/vitest-pool-workers`) for routes, DOs and workflows; pure logic in `packages/core` with plain Vitest (property tests where the milestone asks).
- `pnpm -r typecheck` and `pnpm -r test` must pass before each commit. Commit in logical commits as you go (`git -c user.name=Rolling-Dev -c user.email=dev@rolling.local commit`), staging only your files, each message ending with:

  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RUf2eBWfP5jS6m6acHZTGi

- Don’t deploy and don’t touch remote D1; the lead deploys.

## Report

What you built, the API contract (routes, payloads, WS messages, GraphQL fields), migrations, tests, secrets/config the lead must set, and what is left.
