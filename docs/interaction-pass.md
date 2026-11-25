# Interaction pass: no dead controls

Applies to every agent wiring up screens in `apps/web`. Read `CLAUDE.md`, `docs/decisions.md`, `docs/frontend-build.md` and `docs/design/handoff.md` (§3 components, §4 interaction rules) first. English only in code and comments.

## The rule

Every visible interactive element — button, link, menu row, chip, tab, toggle, segmented option, card, `›` row, icon button, slider, input — must do something observable when used with mouse **and** keyboard:

- open the submenu/popover/dialog the design implies (e.g. a `Language ›` row opens a language list; choosing one updates the row and the app),
- change state that persists through `apps/web/src/lib/prefs` / `lib/session` or the feature's `api.ts` mock (survives reload when it is a preference),
- navigate to the right route, or
- run a mock flow end to end with the same states the real backend will produce (pending → success / error), with a toast or inline feedback where the design shows one.

No `onClick={() => {}}`, no `href="#"`, no static rows. If a feature truly cannot exist yet, the control still responds (e.g. opens a dialog explaining what will happen, or a disabled state with a tooltip reason) — never silent.

## How

- Inventory first: list every control on each screen and state of your area (design files + current React), mark which are dead, then fix them. Put the inventory in your final report.
- Submenus and pickers reuse `@rolling/ui` primitives and the motion tokens (popover enter/exit, stagger); keyboard: Tab, Enter/Space, Esc, arrows in lists.
- Preferences (language, currency, default aspect ratio, default model, creation mode, notifications, theme, confirm threshold) live in `lib/prefs` with one shared state; every place that shows a preference reads and writes the same value.
- Formatting follows the chosen language/currency through `Intl`/react-intl (only English strings exist; other locales fall back to English text but use their number/date/currency formats).
- Colors only through tokens (`var(--c-…)`); no new hard-coded colors (light mode is being added in parallel, D-010).
- Tests: for every control you wire, a Playwright assertion that using it produces the expected change (URL, visible state, stored pref after reload, dialog open, toast). Keep all existing fidelity specs passing; design pixel diffs must not regress.
- Use a unique `PW_PORT` for Playwright runs; other agents run tests in parallel.

## Done means

`pnpm --filter @rolling/web typecheck`, `test`, `build` and your e2e specs pass; your report has the control inventory (before → after), anything left non-functional with the reason, and new test names.
