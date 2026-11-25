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
- English only in code and comments. Numbers, dates, currency through `Intl` / react-intl.

## Done means

`pnpm --filter @rolling/web typecheck`, `test`, `build` and your e2e specs pass; the report lists each screen/state with its pixel-diff number and anything you could not match.
