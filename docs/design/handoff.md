# Design handoff

Source screens: `docs/design/screens/*.dc.html` (index: `canvas.json`). Files ending in `Adv`, `Plus`, `Slash`, `At`, `Model`, `Params`, `Confirm`, `Viewer`, `Edit`, `EditAgent`, `Share`, `Plan`, `Add`, `Script`, `Signup`, `Code`, `Credits`, `Account`, `Prefs`, `Team` are thin wrappers: they import a base screen with a prop that opens one state. The base screen file holds all the markup and logic for that state.

Live canvas (for humans): https://claude.ai/artifact/MwXJH46QqKf7BHSNuB1Yjk

## 1. Screens and routes

| Route | Base file | States to build (wrapper file → prop) |
|---|---|---|
| `/login`, `/signup` | `Login` | sign up (`LoginSignup` → `initMode=Sign up`), email code (`LoginCode` → `initStep=code`) |
| `/` | `Main` | `/` palette (`MainSlash`), `+` menu (`MainPlus`), settings popover (`MainSettings`), `@` picker (`MainAt` → `initAt`) |
| `/p/[projectId]` canvas | `Canvas` | run-all quote (`CanvasPlan`), add node (`CanvasAdd`), script full screen (`CanvasScript`), share (`CanvasShare`), `@` picker (`CanvasAt`), editor (`CanvasEdit`), editor with agent proposal (`CanvasEditAgent`) |
| `/create/quick` | `QuickCreate` | Advanced (`QuickCreateAdv` → `forceMode=Advanced`), model picker, settings popover, confirm, result viewer |
| `/create/remix` | `OriginalVideo` | Advanced |
| `/create/avatar` | `DigitalHuman` | Advanced, lip-sync model picker |
| `/create/character` | `Character` | Advanced, image settings |
| `/templates` | `Templates` | — |
| `/assets` | `Assets` | Characters tab, Voices tab |
| `/assets/public` | `PublicLibrary` | category via `initCat` |
| `/activity` | `Tasks` | filters, failure rows with refunds |
| `/upgrade` | `Upgrade` | monthly / yearly |
| `/settings/[section]` | `Settings` | `account`, `preferences`, `billing` (default), `team`, `notifications` |
| `/u/[handle]` | `Profile` | Published / Templates tabs |
| dialogs | `Paywall` | `variant=join` (non-member), `variant=credits` (`PaywallCredits`) |
| dialogs | `RunConfirm` | single run, run-all plan |
| popovers | `ModelPicker`, `ParamPopover`, `ResultViewer` | per `kind` prop |
| splash | `Splash` | cold start only |

Reference boards, not routes: `BrandRolling` (brand rules), `Brand` (naming round 1, archive), `Motion` (motion spec), `PWA` (icons, manifest, install, offline), `LocaleCheck` (five-language layout check).

Every page uses the shared header (logo, centered nav pill, credits button, settings gear, avatar). Nav order: Home, Canvas, Quick Create, Remix, Avatar, Characters, Assets, Activity. Below 1280px wide the nav shows icons only with tooltips.

## 2. Tokens

Also in `tokens.json` / `tokens.css`.

| Token | Value | Use |
|---|---|---|
| `bg` | `#0B0B0C` | page |
| `surface-1` | `#111113` | editor chrome |
| `surface-2` | `#141416` | cards, panels |
| `surface-3` | `#161618` | nav pill, inputs on page |
| `surface-4` | `#1C1C1F` | popovers, inputs in cards |
| `surface-5` | `#26262A` | chips, secondary buttons |
| `surface-6` | `#2E2E33` | selected chip, hover |
| `border` | `#1F1F23` | dividers |
| `text-1` | `#F5F5F5` | primary text, primary button fill |
| `text-2` | `#C8C8CC` | secondary text |
| `text-3` | `#9A9AA0` | labels |
| `text-4` | `#7C7C84` | hints, meta |
| `accent` | `#3B82F6` | focus, selection, progress, playhead (`#60A5FA` on dark text) |
| `success` | `#4ADE80` on `rgba(34,197,94,.14)` | |
| `warning` | `#FACC15` on `rgba(250,204,21,.12)` | license “Rights reserved”, input changed (`#FFC53D`) |
| `danger` | `#F87171` / `#FCA5A5` | errors, destructive |
| `brand` | `#FFCB2B` | logo, app icon, splash only |
| `pro` | `#B8955A` | PRO badge ring on avatar |

Clip colors in the editor: video `#2B3550`/`#243A40`, voice `#1F3A2C` with waveform `#7FD1A4`, music `#3A3224` with `#D9B26A`, captions `#3B3050`.

Type: Geist for Latin (400/500/600/700), with Noto Sans JP / TC / KR / SC loaded only for the active locale. Numbers use `font-variant-numeric: tabular-nums`, never a monospace font. Sizes: 40 hero, 32–36 page title, 28 section title, 20–22 dialog title, 15–16 prompt text, 14 body, 13 controls, 12 meta, 11 badges. Weights: 700 titles and primary buttons, 600 labels and controls, 400–500 body.

Radii: 999 for pills and round buttons in creation UIs, 10–12 buttons and inputs in account pages, 14–20 cards and popovers, 4–6 editor clips and small controls. Spacing scale 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32. Shadow for floating layers: `0 18px 48px rgba(0,0,0,.6)`. No gradients anywhere (the only exception is the diagonal hatch on a not-yet-generated clip).

## 3. Components

| Component | Where | States |
|---|---|---|
| Header + nav pill | all pages | active item, icon-only at narrow width |
| Credits button + popover | header | balance, plan vs purchased split, used this month, held, expiring, packs, top up |
| Account menu | header avatar | profile, settings, plans and billing, billing and invoices, members, help, workspace switch, log out |
| Settings popover | header gear | creation mode Simple/Advanced, language, currency, default aspect ratio, notify when done |
| Prompt box | Home, tools | modes, model pill first, param pills, `+`, refs chips, Refine, cost, send; left cluster wraps, right cluster never wraps |
| Command palette `/` | prompt box | grouped (Skills, Create, Settings), ↑↓ Enter Esc, empty state |
| Reference picker `@` | prompt box, canvas, agent | tabs All / My assets / Characters / Voices / Public library, public categories, multi-select, source label on each card (Mine, Team, Built-in, Public), upload, empty state |
| Model picker | pills | Auto option, per-model tags, price per 5s or per image, disabled with reason |
| Param popover | pills | grouped segmented controls, cost line |
| Run confirm | before spend | single run vs run-all plan (rows: run / reuse / blocked / nothing to generate), total, balance after, “skip under 20 credits” |
| Paywall | spend without plan / without credits | radio options, CTA continues the same run |
| Node card | canvas | idle, outdated (“Input changed”), generating with progress, done, failed with refund; cost chip only when it will run |
| Agent panel | canvas | conversation, plan option card with cost and “Build on canvas”, composer with LLM pill and Auto |
| Editor | canvas overlay | bin, monitor with timecode, inspector, timeline toolbar, agent command field, proposal card (Apply/Discard), not-generated clip with Generate, regenerate in inspector |
| Activity row | Activity | queued, running with %, done, partial, failed with “Refunded N credits”, canceled |
| Toast | global | one at a time, bottom center, always with an action or a clear outcome |
| Plan card | Upgrade | recommended, credits per month with shot equivalent, features |

## 4. Interaction rules

- **Model pill first** in every prompt box. Skills are reached through `+` or `/`, never as the first pill.
- **`/` palette** opens when the prompt starts with `/` and has no space; filters as you type; Enter runs; Esc clears.
- **`@` picker** opens on `@` at the end of the prompt or from `+ → Add a character or asset`. Selected items become chips above the prompt with their source. Esc closes, Enter adds the selection.
- **Simple vs Advanced** is a setting (Settings → Preferences, and the header settings popover), not a toggle on each page. Advanced shows the left settings panel with model, seed, motion strength, negative prompt, per-shot fields.
- **Quotes everywhere.** Each node and each prompt box shows its cost before running. Run all shows the plan with reuse and blocked rows. Prices are “credits per 5s or per image”.
- **Agent never spends.** Agent output on canvas is a proposal (plan card or node diff) until the user clicks Build on canvas / Apply. Building nodes is free; running them follows the quote rules.
- **Editor.** Opens with the agent’s assembled cut. Agent edit commands return a proposal that outlines what changes on the timeline; Apply commits it, Discard drops it. Regenerate keeps the clip’s place, trims and effects.
- **Failures** refund automatically and say so in the row and a toast with Retry.

## 5. Copy rules

- English, sentence case, short. Verbs on buttons (“Run all”, “Use template”, “Build on canvas”).
- Say what will happen, not how smart it is. No “magic”, “effortlessly”, “unleash”, “AI-powered”. Don’t repeat the same reassurance on every screen.
- Numbers: `15s`, `~2 min`, `12K uses`, `2,480 credits`, `$[PRICE]`. Use `Intl` for all formatting.
- Placeholders stay visible as `[PRICE]`, `[DATE]`, `[DISCOUNT]`, `[BIO …]` until decided.
- Product name appears only as “Rolling” in every locale; no localized name.
- Apostrophes are typographic (’). Quotes are “ ”.

## 6. Localization

English is the source. First wave ja, zh-TW, zh-HK, ko; second wave id, th, vi, es, pt-BR, de, fr; zh-CN on demand. Layout must survive German and katakana lengths (see `LocaleCheck`). Korean uses `word-break: keep-all`. In zh-TW/zh-HK, credits are 點數. Load one CJK font per locale. Thai dates use the Buddhist calendar via `Intl`.

## 7. Motion

Durations: instant 80ms (press), fast 140ms (hover, close), base 200ms (popovers, menus, toasts), slow 320ms (panels, node build, timeline edits), brand 400ms (splash only). Curves: standard `cubic-bezier(.2,0,0,1)` for enter/move, exit `cubic-bezier(.4,0,1,1)`, spring `cubic-bezier(.3,1.4,.4,1)` for brand moments only. Movement 4–16px, scale no lower than 0.96. Lists stagger 30ms, max 6. Real progress only, no shimmer. Reduced motion: opacity only. Demos in `Motion.dc.html`.

## 8. PWA

Manifest: `display: standalone`, `theme_color` and `background_color` `#0B0B0C`, `start_url /`. Icons: maskable 512 (mark inside the 80% safe circle on brand yellow), 192, apple-touch 180, favicon 32. The OS shows its static splash; the in-app intro plays on cold start only, under 1.2s, skipped when the app is ready sooner. Install prompt appears after the first finished video and lives in the account menu; iOS gets “Share → Add to Home Screen” instructions. Offline: canvas and timeline editing work, generation and export wait. Updates: “A new version is ready · Reload”, never auto-reload while a job runs or the editor is open.
