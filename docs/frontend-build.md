# Frontend build rules (parallel screen work)

Applies to every agent building screens in `apps/web`. Read `CLAUDE.md`, `docs/decisions.md`, `docs/design/handoff.md` first.

## Fidelity is the acceptance bar

- The `.dc.html` files in `docs/design/screens/` are the source of truth for layout, spacing, sizes, colors, copy, states **and motion**. Match them; do not reinterpret.
- Render each design file in Chromium with the existing helper (`apps/web/e2e/support/dc-runtime.js`, `design.ts`, `measure.ts`; see `e2e/header.spec.ts` for the pattern) and compare against your React screen:
  - a pixel diff at 1440×900, deviceScaleFactor 1, with the same mock data as the design — target ≤ 1% differing pixels per screen and state; record the actual number in the test;
  - box measurements (±2px) for the main regions and controls;
  - one Playwright spec per screen that opens every state listed in `handoff.md` §1 (the wrapper files show which prop opens which state).
- Look at your screenshots side by side with the design before you report. Save them to `apps/web/e2e/__screens__/<feature>/`.
- Use the design’s copy verbatim (except the product-wide rules in handoff §5). Copy goes in `messages/en/<feature>.json`, keys prefixed `<feature>.`.

## Motion is required, not optional

- Follow `docs/design/screens/Motion.dc.html` and handoff §7: durations (80/140/200/320/400ms), curves (standard, exit, spring only for brand), movement 4–16px, scale ≥ 0.96, list stagger 30ms max 6, real progress only, no shimmer.
- Every popover, menu, dialog, toast, panel, tab switch, node build, hover and press state animates as specified. Exits use the exit curve and are shorter than enters.
- Use the motion tokens and helpers from `@rolling/ui` (CSS variables `--dur-*`, `--ease-*`, and the `motion` package only for layout animation).
- `prefers-reduced-motion`: opacity only. Add a Playwright check that emulates reduced motion for your animated parts.

## Ownership and shared code

- Build inside `apps/web/src/features/<feature>/` (components, CSS modules, mock data in `mocks.ts`) and your route files under `apps/web/src/routes/`. Do not edit other features’ folders or routes.
- `packages/ui` and `apps/web/src/shell` belong to the motion/overlays agent. Shared overlays are exported from `apps/web/src/features/overlays/index.ts` (ModelPicker, ParamPopover, RunConfirm, Paywall, ResultViewer, ReferencePicker lives in `features/prompt`). If an export you need is not there yet, render a clearly named local placeholder (`TODO(overlays)`) and keep going; the lead integrates.
- No new dependencies without asking the lead in your report (preinstalled: React 19, TanStack Router/Query, react-intl, `@xyflow/react`, `motion`, `@rolling/ui`).
- No backend calls yet: screens run on typed mock data shaped like `docs/api.md` responses, behind a tiny `features/<feature>/api.ts` so the real client can replace it.
- Mock data never reaches real mode. Values in `mocks.ts` / `*Mocks.ts` are read only through the mock-mode adapter: register the module in `lib/api/mockData.ts` and read it with `mockData().<feature>` inside `isMockApi()` paths (`lib/api/mode.ts`; real builds drop the registry). No `initialData` / `placeholderData` / `useState` defaults or `?? mocks` fallbacks built from mocks. `lib/api/mockGuard.test.ts` fails on any other import.
- Loading: until a query has data, render a `Skeleton` (`@rolling/ui`) shaped like the final layout (it appears after ~150ms; static under reduced motion); cached data shows at once; truly empty data shows the screen's empty state; a failed load shows `LoadError` with Retry (`lib/loading`). Header numbers (credits, plan) are skeletons until `/api/me`, never 0. `playwright.stubbed.config.ts` checks this in real mode with a slow, empty stubbed API.
- English only in code and comments. Numbers, dates, currency through `Intl` / react-intl.

## Bundle size (first-load budget)

- `vite build` measures what a first visit to Home downloads before it renders (entry chunk, the `_shell` layout and `/` route chunks, and their static imports, gzip) and **fails above 250 kB + 2%** (`apps/web/build/bundleBudget.ts`, so CI fails). Real builds also fail if a mock module reaches the output. `ROLLING_BUNDLE_STATS=<file>` writes per-chunk and per-module numbers; `ROLLING_BUNDLE_BUDGET=off` skips the check for a local measurement.
- Routes are split by TanStack Router (`autoCodeSplitting`). What a route file imports at the top (for `validateSearch`, `beforeLoad`, params) stays in the entry chunk: import only small modules there (`features/canvas/overlays.ts`, `features/account/sections.ts`, `features/legal/ids.ts`), or `await import()` inside `beforeLoad` (`routes/canvas.tsx`).
- Layers opened by a click (dialogs, popovers, pickers) load on demand: `lazyLayer` / `lazyComponent` + `preloadWhenIdle` in `apps/web/src/lib/lazy.tsx`. Import such a layer from its own module, not through a barrel the page imports anyway.
- English messages: only the first-paint features (the list in `apps/web/src/i18n/messages.ts`) ship in the entry; every other `messages/en/<feature>.json`, including a new one, loads right after the first render as one chunk (`loadEnglishRest()`, `src/i18n/englishRest.ts`, whose list mirrors the first-paint one). The root route's loader waits for it on any route but `/`, and every `lazyComponent` / `lazyLayer` waits for it with its chunk. A component Home renders before any click must use first-paint messages only; add its feature to the list if it needs to.
- Links preload the next route's chunk on hover/focus (`defaultPreload: 'intent'`); `useSendToCanvas` loads the canvas chunk when a send starts.
- Service worker: everything is precached (canvas and editor too: offline editing, handoff 8) except translations and the admin console, which `vite.config.ts` writes to `assets/locales/` and `assets/admin/` (admin = modules under `src/routes/admin*` or `src/features/admin/`); the worker caches those once fetched.

## Done means

`pnpm --filter @rolling/web typecheck`, `test`, `build` and your e2e specs pass; the report lists each screen/state with its pixel-diff number and anything you could not match.
