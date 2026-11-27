# UX interaction audit (2026-11-27)

A walk through every screen as a new user, on staging (`https://staging.rolling.actor`) with fresh accounts: signed out, a non-member, a Plus member and a Pro member (`POST /api/test/plan`). Screens were captured at 1440×900, 1280×720 and 1024×768, dark and light, and looked at one by one. Real generations used cheap models: one Seedream 5.0 Flash image (6 credits), one canvas plan run with Grok Imagine Video 1.5 Lite 480p and a keyframe (41 credits) and one Quick Create Seedance 2.0 Mini 480p clip (53 credits), about 100 credits ($1) in all.

Screenshots are in `docs/ux-audit/` (960px wide JPEGs of the staging run, taken before the fixes). Specs for the fixes: `apps/web/e2e/ux-audit.spec.ts` (mocks) and `apps/web/e2e/stubbed-real/ux-audit.spec.ts` (real mode, stubbed API), plus the unit tests named in each item.

Status: **fixed** (commit), **open** (not fixed here, with the reason), **other agent** (in the area of the prompt-box or public-library agent; listed, not edited).

## P0: broken

| # | Screen | Steps | Problem | Fix | Status | Screenshot |
|---|---|---|---|---|---|---|
| 1 | Home | Click “Blank canvas” under the prompt box | Opens `/p/prj_new`: “This canvas doesn’t exist”. The link was the mock id; only the “New project” card created a project in real mode. | Both entries create one untitled canvas (repeat clicks while it is created do nothing, failure toasts) and open it. | fixed `92c6c12` | `ux-audit/h-entry-Blank_canvas.jpg` |
| 2 | Every dialog with a field (rename, invite, seats, share, template preview…) | Open a dialog whose host passes an inline `onOpenChange`, type | `Dialog` re-ran its focus effect on every host render: each keystroke moved focus back to the first control, and on close focus went to `<body>` (the template preview never gave focus back to its card). | `onOpenChange` read through a ref, the effect depends on `open` only; the element to restore is captured before a child’s `autoFocus` runs; an `autoFocus` control keeps focus. Unit tests in `packages/ui` and an e2e on the template preview. | fixed `e57c0a7` | — |

## P1: confusing or wrong

| # | Screen | Steps | Problem | Fix | Status | Screenshot |
|---|---|---|---|---|---|---|
| 3 | Home, Agent mode | Leave the pills at 9:16 · 15s · Auto model and send a brief | The video model, ratio and length pills were never sent: the plan came back 16:9 and 10s. Dead controls. | Turns carry `settings {videoModel, ratio, seconds}` (`POST /api/agent/threads/:id/messages`); the context gets a “Prompt box settings” section the plan follows unless the brief says otherwise. | fixed `92c6c12` | `ux-audit/agent-25s.jpg` |
| 4 | Home agent → Build on canvas → Run all | Plan a shot on a text-to-video model (e.g. Grok Imagine Video 1.5 Lite) and run it | Every shot got a keyframe image, but a t2v shot never reads it: an unconnected node that cost 11 credits per shot and sat in the estimate. | A keyframe only for i2v shots (estimate and nodes); system prompt updated. | fixed `92c6c12` | `ux-audit/build-8.jpg` |
| 5 | Canvas after Build on canvas | Build a plan with a long shot visual | Fixed 260px rows: the video node was placed over the bottom of the tall script node. | Layout stacks by estimated node height (scripts grow with their rows); a shot with no inputs goes right of its script, not under it. | fixed `92c6c12` | `ux-audit/build-8.jpg` |
| 6 | Run all dialog | Run all on a fresh plan | Nodes that never ran said “Regenerate”; the script row read “Script ·” with a dangling dot. | “Generate” for nodes without a result; the dot only with a version label. | fixed `a621a86` | `ux-audit/canvas-runall-1.jpg` |
| 7 | Canvas top bar | Open an empty or fully generated canvas | Run all carried a “~0” cost chip. | The chip shows only when something will run (handoff §3). | fixed `a621a86` | `ux-audit/canvas-run-150.jpg` |
| 8 | Canvas (empty, e.g. from the nav’s Canvas item) | Open a new canvas | Only dots; the agent placeholder talked about “shot 2”. | An empty-state card with “Add a node” and “Start from a template”; the agent placeholder asks for a description. | fixed `a621a86` | `ux-audit/plus-dark-1440-_canvas.jpg` |
| 9 | Upgrade | Open /upgrade as a Plus or Pro member | Headline “Pick a plan to start creating” for members; a Pro member got “Switch to Plus” (a downgrade) as the primary, ringed card. | Members see “Change your plan”; the primary card is the next plan up, none on the top personal plan or Team. | fixed `87abf20` | `ux-audit/pro-dark-1440-_upgrade.jpg` |
| 10 | Activity | Open Activity after a few runs | Thumbnails were colour swatches; the canvas run showed the raw model id (`x-ai/grok-imagine-video-1.5-lite`); “credits · down 0%”, “Done in about 0 min”, “0%” success with no runs; the month-over-month change was sent as a whole percent to a `::percent` format (−12 would read −1,200%). | Result posters as thumbnails; readable model names from the id when the overlay has none; “credits”, “Nothing running”, “–”; the change is a fraction. | fixed `87abf20` | `ux-audit/act-1440.jpg`, `ux-audit/plus-dark-1440-_activity.jpg` |
| 11 | Assets, detail panel | Select a generated video | Empty grey preview; “Format: SHOT 1: BOTTLE ON MOSSY ROCK” (from the name); “Used in” listed `prj_01M8…`. | The video (with poster) or image in the preview; the format from the content type; projects by title. | fixed `87abf20` | `ux-audit/assets-click.jpg` |
| 12 | Header | Any page at 1280×720 as a member | Nav labels plus the right cluster did not fit: the header wrapped onto two rows. | Icons-only nav below 1360px (handoff says 1280; departure noted in the CSS and the spec). | fixed `e908ae5` | `ux-audit/plus-light-1280-_.jpg` |
| 13 | Quick Create, Remix, Avatar, Characters | Open at 1280×720 or 1024×768 | The tool area had a 788px minimum height: the composer (prompt, pills, send) was below the fold. | Minimum 480px; the panels scroll inside. | fixed `e908ae5` | `ux-audit/plus-light-1280-_create_quick.jpg`, `ux-audit/plus-dark-1024-_create_character.jpg` |
| 14 | Home, My projects | Click “All projects ›” | Linked to `/#projects`, the same four cards: a dead end. | Opens the full list in place (“Show fewer” folds it). | fixed `92c6c12` | — |
| 15 | Tool pages (composer) | Type a prompt, press Enter | Nothing happens; Home sends on Enter. | Enter sends, Shift+Enter breaks the line, as on Home. | other agent (prompt box) | `ux-audit/qc-15.jpg` |
| 16 | Quick Create composer | Open Quick Create with no template | Placeholder “Say what to change, e.g. make shot 2 a slow push-in”, which only fits a picked template. The ratio pill shows a portrait icon next to “16:9”. | Template-aware placeholder; the icon follows the ratio. | other agent (prompt box) | `ux-audit/plus-dark-1440-_create_quick.jpg` |
| 17 | Home agent | Send a brief at 1440×900 | The reply and the plan card land below the fold; nothing scrolls them into view. | A new plan scrolls into view with its Build on canvas button (instant under reduced motion); a restored thread doesn’t move the page. | fixed `acc04c4` | `ux-audit/agent-25s.jpg` |

## P2: polish

| # | Screen | Problem | Fix | Status | Screenshot |
|---|---|---|---|---|---|
| 18 | Templates | “0s” duration on Comic page, “0 roles” badge and “0 characters” meta. | No badge or duration when zero; “No characters”. | fixed `87abf20` | `ux-audit/plus-dark-1440-_templates.jpg` |
| 19 | Templates search | No results still said “34 templates”, no way out but deleting the text. | The count follows the filters; “Clear search and filters”. | fixed `87abf20` | `ux-audit/t-noresults.jpg` |
| 20 | Assets (empty) | The empty text sat in one narrow grid cell, no next step. | Full-width empty state with Upload (or “Show all types” when a type filter hides everything). | fixed `87abf20` | `ux-audit/plus-dark-1440-_assets.jpg` |
| 21 | Activity (empty) | No next step. | “Start creating”, or “Clear filters” when filters hide every run. | fixed `87abf20` | `ux-audit/plus-dark-1440-_activity.jpg` |
| 22 | Settings → Team (personal workspace) | “Personal shares one credit pool.” | “Your personal workspace. On the Team plan, members share one credit pool.” | fixed `87abf20` | `ux-audit/plus-dark-1440-_settings_team.jpg` |
| 23 | Settings → Account | The bio field shrank next to its long hint and broke the field column. | Same 280px column as the other fields. | fixed `606cf79` | `ux-audit/plus-dark-1440-_settings_account.jpg` |
| 24 | Profile `/u/<unknown>` | “This profile doesn’t exist or isn’t public.” and nothing else. | “Go to Home”. | fixed `606cf79` | `ux-audit/out-dark-1440-_u_nobody.jpg` |
| 25 | Canvas script node | A long visual ran into the duration (“stands5s”). | 8px before the duration cell. | fixed `f2850d8` | `ux-audit/build-8.jpg` |
| 26 | Home Image mode | The image settings popover for a single-option model (Seedream 5.0 Flash) has nothing to set, only the cost and Reset. | Hide the pill’s popover or say the model has no settings. | other agent (prompt box pills) | `ux-audit/img2-params.jpg` |
| 27 | Home Image mode | Ratio starts at 16:9 while the default aspect ratio preference (9:16) seeds Video and Agent. | Seed the image ratio from the preference too. | other agent (prompt box pills) | — |
| 28 | Activity | Home prompt-box runs are labelled “Quick Create”; a Quick Create run is named “Video”. | The run start would need its surface (Home vs Quick Create) and a prompt-based title. | open (API change) | `ux-audit/act-1440.jpg` |
| 29 | Quick Create feed | A provider without progress shows “Generating 50%” for minutes. | Show elapsed time and “Generating” without a number when the provider reports none (real progress only). | open | `ux-audit/qc-15.jpg` |
| 30 | Settings → Billing | “Other amount” shows a “$ 10” placeholder while a $25 pack is selected, and the bonus line under it describes the pack. | Placeholder empty; the line under the selected source. | open | `ux-audit/plus-dark-1440-_settings_billing.jpg` |
| 31 | Upgrade copy | Pro is “for pros who need 4K and voice cloning”, but Plus lists voice cloning too. | “For pros who need 4K” (pricing copy, owner call). | open | `ux-audit/pro-dark-1440-_upgrade.jpg` |
| 32 | Editor | Escape does not close the editor; the timeline filmstrip and the bin show placeholders, not frames. | Escape closes when nothing is selected; posters in the bin and on clips. | open (bin is in the library agent’s recent changes) | `ux-audit/ed-open.jpg` |
| 33 | Canvas toolbar | “Director” sits disabled (“coming soon”) in the main tool rail. | Hide until it ships. | open (owner call) | — |
| 34 | Agent reply | “I’ll check the video models and their lengths first.” although the system prompt forbids announcing reads. | Prompt/eval work on the agent. | open | `ux-audit/agent-25s.jpg` |
| 35 | Templates preview | A vertical cover leaves a large empty area under the facts. | Top-align the facts and Use template, or size the panel to the cover. | open | — |
| 36 | Home agent | The conversation is remembered per browser only (localStorage), so another device starts empty. | List recent Home threads from `GET /api/agent/threads`. | open | — |

## Checked and fine

Header popovers (credits, settings, account) open, close on Escape and give focus back to their triggers; Home image generation goes queued → generating (timer, ETA, “held, charged only if it succeeds”) → done with View / Open in canvas / Download / Run again; canvas Run all confirm, node progress and results; share dialog; editor opens with the assembled cut and the export dialog; the non-member join flow keeps the brief; signed-out app routes go to `/login?redirect=…`; invite-not-found offers Go to Home.

## Tests

- `pnpm -r typecheck`, `pnpm -r test` (new: `packages/ui` Dialog focus ×2, `packages/agent` prompt box settings, layout by height, no keyframe for t2v, `apps/api` `activity-model-name.test.ts`).
- `apps/web/e2e/ux-audit.spec.ts` (mocks): empty canvas, demo canvas chip, templates, dialog focus restore, header at 1280/1359, composer in short windows, account field column; `upgrade.spec.ts`: members get the next plan up.
- `apps/web/e2e/stubbed-real/ux-audit.spec.ts` (real mode): Blank canvas, All projects, Activity, Assets detail and empty state, unknown profile; `home-runs.spec.ts`: turns carry the pills, a new plan is in view.
- Pre-existing failures, unchanged by this work (they fail on the commit before it too): `header.spec.ts` credits popover presets, non-member credits popover, and Top up mock checkout.
