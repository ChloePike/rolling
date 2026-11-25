# Build order

Work top to bottom. Finish a milestone’s acceptance checks before starting the next. Each milestone ends with a deploy to `staging`.

## M0 — Skeleton
- pnpm workspace with `apps/api`, `apps/web`, `containers/ffmpeg`, `packages/{core,agent,db,ui}`.
- Worker with Hono, static assets serving the Vite SPA, `wrangler.jsonc` with all bindings declared (D1, R2, DO classes, Workflows, Queues, Container, Rate Limiting, Analytics Engine).
- `packages/ui/tokens.css` from `docs/design/tokens.css`; primitives: Button, Pill, IconButton, Popover, Dialog, Toast, SegmentedControl, Switch, Tabs, Input.
- `react-intl` with `messages/en.json`; Geist font; app shell with the shared header and nav (static data).

Accept: `wrangler dev` serves the shell; Vitest (workers pool) and Playwright run in CI; header matches `Main.dc.html` at 1440 and 1180 widths.

## M0.5 — Model spike (Hyperouter)
Runs in parallel with M0. Goal: prove the generation path before building billing.
- `packages/core/models`: `GenerationProvider` / `LlmProvider` interfaces, Hyperouter adapter (fetch only): image create (`Prefer: respond-async`), video create, status polling, content download, Standard Webhooks verification, error mapping (`insufficient_credits`, `content_rejected`, `rate_limited`, `x-should-retry`), `Idempotency-Key` on every create.
- Capabilities table for the mapped launch models (D-002), confirmed against `GET /v1/models`.
- `scripts/spike.ts`: one image (Seedream Lite) and one 5s video (Seedance 2.0 mini), poll to completion, print cost and latency; one DeepSeek chat call with a tool call (streamed). No credit ledger yet.
- PoseWear: map the data index (`/assets/poses.*.json`) to the `public_library` schema and write the import script (dry run, no R2 writes yet).

Accept: unit tests with mocked fetch for every status path and webhook signature (valid, bad signature, stale timestamp, duplicate id); a real spike run on a test key produces an image and a video URL; tool-call streaming confirmed or JSON-mode fallback chosen.

## M1 — Auth, workspaces, prefs
- Better Auth on D1 (Google, Apple, email code); `Login` screens and states.
- Date of birth at sign-up, mature-content opt-in (D-005).
- Personal workspace on sign-up; `/api/me`; `UserHub` socket; GraphQL endpoint skeleton; prefs (Settings → Account, Preferences) and the header settings popover.

Accept: sign up with email code, log out/in, change language/creation mode and see it persist.

## M2 — Billing and credits
- `CreditAccount` DO with quote/hold/settle/release/grant/purchase/expire, idempotency, member limits; ledger mirror queue to D1.
- Stripe products/prices from `packages/core/pricing/config.ts`; Checkout for plans and packs with `resume`; customer portal; webhooks; `Upgrade` page; Settings → Plan and billing (balance split, buy credits, auto top-up, payment method, invoices).
- Header credits popover; Paywall dialogs (`join`, `credits`).

Accept: Vitest property tests on the ledger (no sequence of ops makes a bucket negative or double-settles a job); Stripe test mode: subscribe → credits granted; buy pack → purchased increases; renewal expires leftover plan credits; non-member generating opens Paywall and resumes after checkout.

## M3 — Projects, canvas, graph
- `ProjectRoom` DO: graph tables, patch ops (`GraphOp`), revisions, patch log (undo/redo), WebSocket hibernation, D1 index updates.
- Canvas UI with `@xyflow/react`: node kinds, typed ports with validation, groups, add-node menu, script full screen, autosave, conflict handling, share snapshot.
- Assets: presigned uploads to R2, `media.process` queue + Container probe/thumbnail/waveform, Assets pages, Characters and Voices lists.

Accept: two tabs editing one project stay in sync; invalid connections are refused with a reason; refresh restores everything.

## M4 — Generation
- Model gateway with providers for Seedance 2.5, MiniMax H3, Wan 3.0, Wan 2.2, Seedream 5.0 Pro/Lite, Wan 2.7 Image, Wan 2.2 S2V; capabilities and Auto selection.
- Quote endpoint with run/reuse/blocked plan; Run confirm dialog (single and run-all); confirm threshold.
- `GenerateWorkflow` (submit, webhook/poll, store, commit, settle/release); node states (generating %, done, failed with refund); staleness (“Input changed”); version history and active version.
- Activity page; refund toast.

Accept: run-all on the sample graph reuses valid versions, blocks a node with a missing input, charges only for successful items, refunds a forced failure, and shows each in Activity.

## M5 — Home and creation tools
- Home prompt box: modes, model pill, param popovers, `+` menu, `/` palette, `@` picker (D1 FTS over assets + public library), cost line.
- Quick Create, Remix, Avatar, Characters in Simple and Advanced modes (all states listed in `docs/design/handoff.md`), Templates page, Public library page with license labels, result viewer.

Accept: each tool can produce a result end to end on staging models; Advanced fields map to provider params; `@` picks from all scopes.

## M6 — Agent
- `AgentSession` DO, `LlmProvider` for DeepSeek, tools and proposal types from `docs/harness.md`, skills (`tv-ad`, `product-showcase`, `storyboard`, `ai-comic`, `brand-kit`).
- Home Agent mode → plan options → Build on canvas; canvas agent panel with graph-patch proposals and diff highlight; Simple-mode field filling for tools.
- Eval suite (40 briefs) in CI.

Accept: eval pass rate ≥ 90% on invariants; the agent never creates a run; applying a proposal produces exactly the patch shown.

## M7 — Editor and export
- Timeline EDL in ProjectRoom; assemble from script; editor UI (bin, monitor, inspector, canvas-drawn timeline, tools, snapping, keyframed music gain, captions).
- Agent timeline proposals (Apply/Discard with outlines); regenerate a shot in place; placeholder clip with Generate.
- `ExportWorkflow` + Container FFmpeg → MP4 1080p.

Accept: a 3-shot project assembles to a cut whose duration equals the script; “cut to 10s” proposal applies cleanly; exported MP4 matches the preview (duration, caption timing ±1 frame).

## M8 — PWA, motion, locales, polish
- `vite-plugin-pwa`: manifest and icons from `PWA.dc.html`, offline route, update prompt rules, install prompt rules.
- Motion tokens applied; reduced motion.
- Locales ja, zh-TW, zh-HK, ko with the layout checks in `LocaleCheck.dc.html`.
- Profile page, team settings, notifications, splash.

Accept: Lighthouse PWA installable; offline canvas editing; all screens pass at 1440 and 1180 widths in en, de and ja.
