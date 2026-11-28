# Feature test matrix

The end-to-end feature suite in `apps/web/e2e/full/` runs against a deployed Worker: staging by default (real Hyperouter, test inbox, `POST /api/test/plan`) and, for the `full-prod` project, a signed-out smoke on production. Each row lists a feature, its acceptance checks and where they come from, and the test ids that cover them. Ids match the test titles, so `-g "GATE-4"` runs one row.

```sh
cd apps/web
TEST_INBOX_TOKEN=… pnpm exec playwright test -c playwright.full.config.ts --project=full --trace off
pnpm exec playwright test -c playwright.full.config.ts --project=full-prod --trace off        # production smoke
PW_GENERATE=1 PW_EXPORT=1 …                                                                  # add real generations (cheap models)
PW_AXE_PATH=/path/to/axe.min.js …                                                             # add the axe-core smoke (X-5)
```

- Every spec signs in its own fresh accounts (`full.<tag>.<ts>@rolling.test`) through the test inbox, so specs never share state.
- Members get a plan through `POST /api/test/plan` (staging only). Nothing in the default run spends credits: quotes, forced failures (`options.forceFailure`, refunded) and refused starts only.
- `PW_GENERATE=1` runs the specs that generate for real: Seedream 5.0 Flash images (about 7 credits with Enhance prompt), Grok Imagine Video 1.5 Lite at 480p for 1–2 s (about 6–12 credits) and one mature keyframe → animation chain (Z-Image Spicy + Wan 2.2 i2v Spicy, 480p, 1 s, Enhance prompt off, about 34 credits). Each charge is appended to `<PW_FULL_OUT>/spend.jsonl`. The suite budget is 500 credits ($5 retail, `SPEND_CEILING_CREDITS`).
- Mature tests use only mildly explicit prompts about fictional adults. Hard limits are checked only at quote time (the rules refuse them before anything is held); no run is ever started with them.
- While an environment takes no payments (`GET /api/billing/plans` → `paymentsEnabled: false`, staging today), every locked click opens the upgrade modal titled by the reason (“The agent needs a plan”, “1080p needs Plus”) with a “Payments aren’t available yet” notice under it instead of the offer; with payments on it shows the offer. `expectUpgradeModal` checks the reason headline either way.
- The crawl (X-1) never clicks sign-out, delete, buy, or plan-switch controls. It answers run starts, checkout and agent sends with stubbed errors, so it cannot spend.

Sources: **PRD** = `docs/PRD.md`, **M*n*** = `docs/milestones.md`, **CF*n*** = `docs/canvas-flow.md` step, **D-*nnn*** = `docs/decisions.md`, **HO** = `docs/design/handoff.md`, **API** = `docs/api.md`.

## Auth

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Email-code sign-up | `/signup` → email → 6-digit code from the inbox → Home. The account gets a personal workspace and the owner role. No console errors. | M1, API Auth | AUTH-1 |
| Email-code sign-in | A wrong code shows the inline error. The right code signs in. | M1, HO Login | AUTH-2 |
| Resend cooldown | The UI shows “Resend in 0:30”, disabled. A second send within 30 s gets `429 RATE_LIMITED` with `retryAfter` ≤ 30. | API Auth | AUTH-3 |
| Sign-out | Account menu → Log out → `/login`. `/api/me` returns 401 and app routes bounce to the login page. | M1 | AUTH-4 |
| Google (API, stubbed tokens) | Providers lists the client id and `loginUri`. The nonce response is `no-store`. `/google/start` returns 302 to Google with `id_token` + `form_post` and sets the state cookie. Stubbed access, ID and credential tokens are refused with 4xx (never 5xx) and no session. | D-017 | AUTH-5 |
| Google button | Our designed “Continue with Google” button, not Google’s iframe; no Apple | D-017 | AUTH-6 |
| Session expiry | A dead session cookie on an app route → `/login?redirect=<path>`. After sign-in the user is back on that path. | API, guard | AUTH-7 |
| Redirect param | Same-site paths are honoured. `https://…` and `//…` targets fall back to `/`. | guard | AUTH-8 |
| Unauthenticated API | `/api/me`, `/billing`, `/projects`, `/runs` answer `401 UNAUTHENTICATED` | API | AUTH-9 |

## Membership gate and plans

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Non-members browse | Home, Templates, Public library, Assets, Activity, Upgrade and Billing load with no errors | D-007 | GATE-1 |
| `NO_PLAN` | The agent (threads, allowance) and run starts (tool and canvas) return `402 NO_PLAN`; quotes stay open. Top-up and auto top-up are members-only. | D-007, API | GATE-2 |
| Upgrade modal keeps the brief | A non-member’s Home brief opens the upgrade modal in place: Agent mode “The agent needs a plan”, Image mode “Pick a plan to generate” (with the “Payments aren’t available yet” notice while payments are off). Escape keeps the brief and the URL. | D-007, CF13 | GATE-3, PROMPT-4 |
| Resolution caps (API) | Video caps: Starter 720p, Plus 1080p, Pro 4K. Locked rows are `resolution_locked` with `lowestPlan` and nothing to start. MiniMax 768p needs Plus. Unknown labels are refused. | D-006 | GATE-4 |
| Resolution caps (UI) | For Starter, 1080p is shown locked with “Available on Plus” | D-006, HO | GATE-5 |
| Team required | Inviting without Team returns `402 TEAM_REQUIRED {currentPlan}`. Invite member opens the upgrade modal’s Team variant (seat stepper, monthly total from the config) in place. | D-013 | GATE-6 |
| Seats, roles, member limits | Inviting past the purchased seats returns `SEATS_REQUIRED {seats, used, needed}`. The invite email’s link is accepted. A per-member monthly limit refuses the start with `MEMBER_LIMIT_REACHED`. A viewer can’t quote or spend (`403 FORBIDDEN`) or edit (403) but can read. Lowering seats below use returns `SEATS_IN_USE`. | D-013, PRD 7 | GATE-7 |
| Team settings | Seats panel, roles, invite dialog sends | HO Settings → Team | GATE-8 |

## Billing and credits

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Plans API mirrors config | Credits, bonuses, caps, top-up tiers, presets and auto top-up equal `packages/core/pricing/config.ts` | D-006 | BILL-1 |
| Top-up minimum and bonus math | Under $10, fractional cents and over $10,000 are refused (400). Checkout returns a Stripe URL, or a clean `503` when Stripe is not configured. Settings chips, the custom amount and the Upgrade calculator show `quoteTopUp(amount, plan)`. | D-006 | BILL-2 |
| Auto top-up | Defaults are 200 / $10. Custom values persist, an amount under $10 is refused, and the toggle shows in Settings. | D-006, API | BILL-3 |
| Confirm threshold | Default is 300. `needsConfirm` is true at or above it. `prefs.confirmThreshold` moves it. | D-006 | BILL-4 |
| Quote → hold → release on failure | A forced failure is refunded in full. A repeat start with the same quote returns the same run. The balance is unchanged with nothing held. The ledger shows hold + refund. Activity shows “Refunded N credits”. | PRD 4/8, M4 | BILL-5 |
| Quote → hold → settle | spent ≤ quoted; balance drops by spent; ledger hold + settle | PRD 4 | GEN-1 |
| Ledger / credit history | Grant and purchase lines, newest first, paginated. The Settings history and the header popover split plan from purchased credits. | M2, API | BILL-6 |
| Not enough credits | `402 INSUFFICIENT_CREDITS {needed, balance}`. Run all opens “Not enough credits” with short-by, and nothing is held. | PRD 6, HO Paywall | BILL-7 |
| Plan and billing page | Plan, price, balance split, invoices empty state, credit history. Plan credits are not labelled “bonus” (design copy). | HO Settings | SET-8 |

## Projects and canvas

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Create | Nav “Canvas” with no projects creates and opens one, and reopens it next time. Home “New project” creates another. | owner, HO | CANVAS-1 |
| Nodes | The Add node menu adds Text/Image/Video, which persist after reload. Director and Auto edit show “Coming soon”. | M3, HO | CANVAS-2 |
| Wires and refused wires | An invalid wire is refused with a reason (UI toast, API `422 VALIDATION_FAILED`). Disconnect, undo and redo work, sync to a second tab and persist after reload. | M3, CF4 | CANVAS-3 |
| Multi-tab sync (global WS) | A prompt edit reaches tab 2 over `/api/ws` with no per-project socket (D-014). It persists after reload. API undo/redo restores and reapplies it. | M3, D-014 | CANVAS-4 |
| Run up to / from here | Quote scopes `upTo` / `from` / `node` / `all` pick the right rows. The node menu opens the plan dialog, Esc closes it, nothing is spent. | HO, API Runs | CANVAS-5 |
| Bypass | The menu toggles it with a toast and a “Bypassed” mark. The quote marks the node `bypassed`. It persists after reload and can be turned off. | HO, API | CANVAS-6 |
| Reroute, collapse | A reroute point on a wire, plus collapse/expand, persist after reload. Delete removes the reroute. | HO | CANVAS-7 |
| Delete node, undo/redo | The menu Delete shows a toast with Undo. Keyboard Delete and Ctrl+Z restore the node and its edges. | HO | CANVAS-8 |
| Delete project | API DELETE: an open tab shows “deleted”, after reload “doesn’t exist”, and the project leaves the index. The UI deletes from the Home card “…” menu (Rename, Delete) and the canvas project menu, each behind a confirm (no restore API); the canvas then goes Home and forgets the last-canvas id. | API, HO | CANVAS-9, CANVAS-10 |
| Conflicts | A stale `baseRevision` returns `409 CONFLICT` with the snapshot | API | CANVAS-11 |
| Missing / foreign project | “This canvas doesn’t exist” | API | CANVAS-12 |
| Canvas targets | Nav Canvas opens the last canvas opened, else the most recently updated one. A missing canvas offers “Go to your canvases” and “New canvas” (which creates and opens one). No `prj_demo` in real paths. | owner | CANVAS-14 |
| Initial fit | The first fit keeps every node right of the left tool rail (and left of the agent panel) | HO Canvas | CANVAS-13 |
| Versions, “Input changed” | Run node → done. An upstream edit marks the node outdated with “Input changed”. A rerun adds version 2. Switching to version 1 persists after reload. | M4, CF8 | GEN-5 |
| Home cards | Node count follows the canvas | HO | LIB-8 |

## Prompt box

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Model picker | Auto first. Every non-tool catalog model of the mode is listed (placement `more` behind “More models (N)”); Berry appears as “Wan 3.0”. No face/head swap, LoRA, animate or face detect, and no models of the other kind. The panel fits the viewport. | D-009 | PROMPT-1 |
| Params from capabilities | Home and canvas settings come from the selected model, not the mode: the resolution options are exactly the model’s (Seedance 2.0 Mini: no 1080p), the duration note shows the model’s max, image count follows `imagesPerRequest` (Seedream 5.0 Flash: 1, shown as read-only pills with no popover, UX audit #26), unsupported values refit to the closest one, plan locks still apply, and a blocked quote shows its reason instead of a number | HO, D-002, D-006 | PROMPT-2 |
| `@` references | Tabs All / My assets / Characters / Voices / Public library. A public item becomes a chip with a source label. | HO, M5 | PROMPT-3 |
| Enter / IME | Enter sends. Shift+Enter adds a new line. Enter during IME composition does not send. | owner | PROMPT-4 |
| `/` palette | Skills / Create / Settings groups, filtering, an empty state, Esc closes | HO | PROMPT-5 |
| No demo literals | A fresh account sees no mock projects, names or numbers on Home, the tools, Activity, Assets, Billing or Team | owner | PROMPT-6 |
| Cost line | Agent: “Planning uses no credits”. Image: a live quote. | HO | PROMPT-7 |

## Generation (real, `PW_GENERATE=1`)

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Image | done; settle ≤ quote; signed media URL (not `/api`); ledger hold + settle | M4 | GEN-1 |
| Video | Cheapest model, 480p, 1 s: done. Plays from a signed URL with `Range` → 206. `?variant=poster` redirects to a poster image (the provider’s, else stills from the clip). | M4, D-005 | GEN-2 |
| Cancel | A running video is canceled; spent 0, balance unchanged, nothing held | PRD 4 | GEN-3 |
| Home Image mode | Under the threshold it starts without a dialog. The run card under the prompt box (no toasts) goes to done with the charge and, when the gateway rewrote the prompt, “Enhanced prompt”. The result viewer opens and the run appears in Activity. | HO, D-020 | GEN-4 |
| Versions / input changed | See the canvas section | CF8 | GEN-5 |
| Auto / fallback visibility | The quote names the model and how it was chosen (`autoVia`). The run reports the model it used. | D-009 | GEN-6 |
| Failure refund | A forced failure is refunded (see BILL-5) | M4, CF7 | BILL-5 |
| Safety classifier | An unsafe prompt that passes the rules is blocked before the provider: `safety_blocked`, nothing spent, no asset | D-005 | GEN-7 |
| Mature gate | The preference needs a plan (`NO_PLAN`). For a member without it, an explicit prompt gets `MATURE_REQUIRED` and a mature run `mature_not_allowed`. With it, mature runs. Hard limits (minor, real person) give `SAFETY_BLOCKED` whatever the settings. Swaps are never mature. | D-005 | GEN-8, MAT-1 … MAT-3 |

## Agent

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Members only | `NO_PLAN` for non-members | D-007 | GATE-2 |
| Allowance per plan | Starter $1.20 / Plus $3.50 / Pro $12.50. DeepSeek (including 1017) is unlimited. turnsLeft ≈ remaining ÷ estimate. Opus gets fewer turns than Haiku. Only public ids. | D-012 | AGENT-1 |
| LLM routing | A turn on `deepseek-v4.1-flash-1017` answers on that id. A gateway id is refused (400). An unmetered turn leaves `usedUsd` 0. | D-009, D-012 | AGENT-2 |
| Plan proposal + approval gate | Brief → 2+ plan options with credits → Build on canvas → nodes. No runs, balance unchanged. | CF1–2, M6 | AGENT-3 |
| Graph patch | The proposal shows a diff highlight. Apply produces exactly the shown `updateNode` params and one revision, with no runs. Discard leaves the revision unchanged. | CF9, M6 | AGENT-4 |
| Timeline patch | Editor “cut to 10s” → Apply: duration 15 → 10 | CF10, M7 | AGENT-5 |
| Agent LLM picker | Lists public LLMs with “~N turns left”. DeepSeek shows no count. | D-012 | AGENT-6 |
| Harness: pills, shots, characters | A turn carries the prompt box pills (`settings {ratio, seconds, videoModel}`); every plan option follows them unless the brief says otherwise, and its shot lengths add up. Shots come as fields (`shot {subject, action, …}`); a recurring character is described once in `characters`; keyframe images only for image-to-video shots; the reply never narrates reads. | ef6f523, UX audit #3, #4, #34 | AGENT-7 |
| Harness: Build on canvas | Applying a plan option makes one video node per shot with its `shot` fields and the ratio; agent-planned nodes have Enhance prompt off and their quote prices no rewrite (D-020); nothing runs. | D-020, CF2 | AGENT-8 |

## Home

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Run cards | An Image/Video send becomes a card under the prompt box (no “started · held” toast) that follows the run. A failure shows the reason, “No credits were charged · N held credits released” and Retry; the card survives a reload; the run’s `surface` is `home` and Activity says Home. | 91f8b48, UX audit #28, #29 | HOME-1, GEN-4 |
| Agent conversation | Small talk gets a short reply and no plan; a brief gets a plan card whose Build on canvas is in view. The thread survives a reload, comes back from the server (GraphQL `agentThreads`) on another device, and Recent switches conversations. | 91f8b48, UX audit #17, #36 | HOME-2, AGENT-3 |
| Blank canvas, All projects | Blank canvas creates one project (even on a double click) and opens it; All projects opens the full list in place, Show fewer folds it. | UX audit #1, #14 | HOME-3 |

## Enhance prompt (D-020)

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Quote and preference | `prefs.enhancePrompt` defaults on. Models list `promptExpand`. The quote marks the item `promptExpand` and adds the rewrite’s most (about 1 credit with DeepSeek); a per-run choice wins, else the preference; models without `prompt_expand` never price it. The spoken-line locale (follows the prompt) is only in the gateway request: unit tests (`promptLocale`). | D-020 | ENH-1 |
| Home pill, Preferences | “Enhance prompt: on” by default; turning it off lowers the live cost; the Preferences switch sets the default and persists. | D-020 | ENH-2 |
| Tools and canvas | Quick Create shows the switch (on). A user-made canvas image node shows the pill; its plan dialog row says “Includes prompt enhancement” and the total is the server quote. | D-020 | ENH-3 |

## Mature content (D-005 amendments)

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Access copy and auto-routing | A mildly explicit prompt: non-member → `MATURE_REQUIRED` `no_plan` (“Mature content needs a paid plan …”); member with the preference off → `preference_off` (“Turn on mature content in Settings …”); mature-allowed → runs on a mature-capable model, also when the request names one that is not; benign prompts keep their model. | D-005 (2026-11-26) | MAT-1 |
| Hard limits | For a mature-allowed caller, minors and sexual content with animals (`bestiality`, “sex with a dog”: `ANIMAL_SEXUAL`) are refused at quote time for images and videos (no quote id, nothing held); a pet in a non-sexual scene is fine. | D-005 | MAT-2, GEN-8 |
| Text-to-video chain | A mature text-only video quotes two steps: `keyframe` on a mature picture model, then `animate` on a spicy image-to-video model that depends on it; the total is their sum; Auto chains too; non-mature text-to-video is one item. | D-005 (2026-11-26) | MAT-3 |
| Chain run, posters | (`PW_GENERATE=1`) The chain runs, held once and settled per step (spent ≤ quoted, nothing held after); both outputs are kept and mature; the clip’s poster (`?variant=poster`) is an image made from its frames; Activity lists the run. | D-005 (2026-11-26) | MAT-6 |
| Mature public library | Mature-allowed members get the mature items and counts (`mature: true`, signed `cdn-private` URLs that load; the unsigned path is refused; `Cache-Control: private`, edge cache BYPASS) and the Mature chip on cards; everyone else gets exactly the general set, and the allowed caller’s answer is never served to others. | D-005 (2026-11-27) | MAT-4, LIB-2 |

## Asset picker and upgrade modal

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| One picker everywhere | Home prompt box (Choose from Assets), Quick Create composer, Remix preset, Avatar character, Character face, canvas rail Assets: each opens the same modal (My assets / Public library tabs, Upload, Cancel); Escape closes it. | d94018a | PICK-1 |
| Uploads go to Assets | Upload from the picker: the new asset is selected, used in the composer, listed by the API and on the Assets page; no upload bytes through `/api`. | d94018a, D-011 | PICK-2 |
| Picker on the canvas | Picking one of my assets from the rail adds an asset node. | d94018a | PICK-3 |
| Locked clicks | Starter clicking 1080p in Quick Create opens “1080p needs Plus” in place (URL unchanged); Escape keeps the prompt and 720p. A non-member’s Mature content switch opens “Mature content needs a plan” and stays off; no top-ups for non-members. | 2171328, D-006, D-007 | UPG-1, UPG-2, GATE-3, GATE-6, EDIT-5 |
| Upgrade for members | Header Upgrade for non-members, Starter and Plus; hidden for Pro and Team. `/upgrade` says “Change your plan”; Plus sees Pro recommended; Pro sees no recommendation (no downgrade pushed); taglines from the config; voice cloning “coming soon”. | 5668c24, UX audit #9, #31 | UPG-3, UPG-4 |

## UX audit fixes (docs/ux-audit.md)

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Canvas | An empty canvas offers Add a node and Start from a template; Run all has no “~0” chip; no Director in the tool rail; never-run nodes say Generate in the Run all dialog. | #6, #7, #8, #33 | UX-1 |
| Empty states | Templates with no match offer “Clear search and filters”; empty Assets offers Upload; empty Activity offers “Start creating” (no “down 0%”); an unknown profile offers “Go to Home”. | #18–#21, #24 | UX-2 |
| Short windows | At 1280×720 and 1024×768 the header is one row and the tool composer is on screen. | #12, #13 | UX-3 |
| Settings copy | Team: “Your personal workspace. On the Team plan, members share one credit pool.” Billing’s other amount reads “Any amount” and is empty until typed. | #22, #30 | UX-4 |
| Editor and focus | Escape closes the editor; renaming a project keeps focus in the field while typing. | #2, #32 | UX-5 |

## Editor and timeline

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Assemble | Script rows become shots in order, lines become captions, and the duration equals the script | M7 | EDIT-1 |
| Clip ops | Trim, speed, fade and dissolve persist. A stale revision gets 409; an invalid speed gets 4xx. | M7 | EDIT-2 |
| Editor UI | Timeline canvas, monitor timecode, placeholder clips with Generate. The inspector speed control persists. | HO Editor | EDIT-3 |
| Export | Three 1 s shots → Export 720p via the FFmpeg container → done → Download `.mp4`. Generated clips show their controls (transform, speed, volume, fade) in the inspector. | M7, CF11 | EDIT-4 |
| Non-member Generate in the editor | A placeholder clip’s Generate opens the upgrade modal (“Pick a plan to generate”, with the “Payments aren’t available yet” notice while payments are off), never “Not enough credits”, shows no saved card and starts nothing | D-007 | EDIT-5 |

## Uploads and downloads

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Chunked, direct to R2, resumable | 17 MiB → 3 × 8 MiB parts with presigned R2 URLs (`direct: true`). Kill after 2 parts: the server lists them and the same fingerprint resumes the same upload. An early complete is refused. Then complete and check the size. Abort. | D-011 | UP-1 |
| SharedWorker queue, concurrent files | The SharedWorker exists. Three files upload concurrently through the dock and appear in Assets. No upload bytes go through `/api`. | D-011 | UP-2 |
| Resume after reload | Kill the tab mid-upload (40 MiB). The queue finishes it from IndexedDB. | D-011 | UP-3 |
| Face detect on upload | An uploaded portrait gets a rating and `meta.faces` from `lumina/face-detect` (status `done`, count ≥ 1, boxes, apparent-minor flag); videos use the poster frame. An outage is stored as `unavailable`, and mature runs then detect again and fail closed. | owner, D-005 | UP-4 |
| Background download | Asset details → Download goes through the queue and saves the file | D-011 | UP-5 |

## Assets, library, templates

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Public library (API) | Categories with counts. License labels (FIRST_PARTY / CC0 / MIT). Category filter and search. | D-004 | LIB-1 |
| Mature hidden | Signed-out visitors and members without mature access get exactly the general set (counts and items); a mature-allowed member gets more; turning the preference off restores the general set | D-005 | LIB-2, MAT-4 |
| Sub-category labels | Every sub-category the API returns (general and mature, CharaDB hairstyles, anime outfits) has a label in `messages/en/library.json`, never a raw key | HO, D-004 | LIB-9 |
| CharaDB import | Hairstyles (122) and CharaDB anime outfits: CC0, attribution CharaDB, images on the public media host | D-004 | MAT-5 |
| Public library page | Grid images load, “Show more” loads more, search works | HO | LIB-3 |
| Assets page, characters | An upload appears. Kind filter and search narrow the list. Characters is empty for a new account; nav goes to Characters. | HO | LIB-4 |
| Templates | Every template has a cover that loads. Search works. Preview → “Use template” (Quick Create, then “Open on canvas”) creates a canvas with nodes and spends nothing. | HO, owner | LIB-5 |
| Inspiration grid | Cards show covers and durations at rest; Use template shows on hover or focus; tabs switch | HO | LIB-6 |
| Send to canvas | “Add to canvas” opens the canvas picker. Picking a canvas adds a node; “New canvas” creates one. | HO | LIB-7 |

## Tools

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Quick Create | Composer with a live cost. Generate shows confirm or paywall; Esc spends nothing. | M5 | TOOL-1 |
| Remix | Without a reference video the quote has `missing_input` and the UI asks for the video | M5 | TOOL-2 |
| Avatar (TTS undecided) | The quote asks for an uploaded voice track (`missing_input`). The UI offers “Upload a voice track”. Built-in voices are not presented as working. | CLAUDE.md open decisions | TOOL-3 |
| Characters | Styles toggle, “Generate 2 views”, cost line | M5 | TOOL-4 |
| Character run | body then face (`dependsOn`), saved to Characters | API | TOOL-5 |

## Settings

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Profile | Name, handle and bio persist after reload. Bad handles get 400. | API | SET-1 |
| Avatar upload | Change photo → picture shows from signed media; `/api/media/avatar/:id` returns 302 | API, D-008 | SET-2 |
| Google link | Manage sign-in → Google Connect. `start?intent=link` returns 302. | D-017 | SET-3 |
| Theme | System follows the OS live. Light and Dark override it. The value persists in prefs and after reload. `theme-color` follows the theme. | D-010 | SET-4 |
| Language; no currency | Language options are listed. There is no currency control (Preferences, header settings popover); prices show in USD even after an old client sets `currency: EUR`. An invalid currency gets 400. | M1, HO, D-019 | SET-5 |
| Preferences | Creation mode persists and shows in the header popover. An empty or unknown body gets 400. | M1 | SET-6 |
| Notifications | Toggles persist after reload | HO | SET-7 |
| Plan and billing | See SET-8 under Billing | HO | SET-8 |
| Data export | 202, then 429 on a second request. The export finishes and emails `data-export-ready`. | API | SET-9 |
| Account deletion | Code by email. A wrong code gets `INVALID_CODE`. The right code deletes the account and signs out; the same email signs up as a new user. | API | SET-10 |
| Team (member photos) | See GATE-8 | HO | GATE-8 |

## Sharing

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Share links | Publish from the dialog, then Copy link. Signed-out viewers get a read-only board (no Run all, no errors). After revoking, the page says the link isn’t available and the API returns 404. | CF12 | SHARE-1 |
| Public profile | `/u/:handle` works signed out and case-insensitively, showing name and bio. Unknown handles show “unavailable”. | HO Profile | SHARE-2 |
| Workspace-only links | 404 signed out, 200 for members | API | SHARE-3 |

## Media

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Public media host | Public library and template images come from `media(-staging).rolling.actor`, cached long-term, never `/api` | D-008, D-015 | MEDIA-1 |
| Signed private media | Served from `cdn-private(-staging)` with a signature. Range returns 206. A tampered or expired signature is refused. The convenience route only redirects. | D-008 | MEDIA-2, GEN-1, GEN-2 |
| No `/api/media` in pages | No image or media requests to `/api/media/` on Home, Templates or Public library | D-008 | MEDIA-3 |

## Platform

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| D1 read replicas | `/api/health?timing=1` reports D1 time, region and primary; API responses carry `Server-Timing` (`d1;dur`, `total;dur`) and `x-d1-bookmark`; a bookmark sent back starts the session there (the answer is never older); junk bookmarks are ignored (200). | 135a3e7 | PLAT-1, PROD-6 |
| Read-your-writes | A write hands back a bookmark (header and `rolling.d1b` cookie); a read that sends it sees the write. | 41f534c | PLAT-2 |
| Admin grant | `POST /api/admin/grant` is 404 where `ADMIN_TOKEN` is unset (staging) and 401 with a missing or wrong token (production); GET is 404. Never called with a real token. | cc5d49d | PLAT-3, PROD-5 |
| Workers static assets | Hashed `/assets/*` are immutable for a year; the shell is revalidated; `sw.js` is `no-cache` with `Service-Worker-Allowed: /`; app documents carry `Link` preloads (Early Hints) for the entry, stylesheet and font, legal pages do not; deep routes get the shell. | 80f2792, 41f534c | PLAT-4, PROD-6 |

## PWA

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Manifest | standalone, `#0B0B0C`, `start_url /`, icons 192/512 maskable, all load | HO PWA, M8 | PWA-1 |
| Service worker | Registers at scope `/` and controls the page after reload | M8 | PWA-2 |
| Offline page | Offline navigation shows the offline page; back online the app recovers | M8 | PWA-3 |
| Silent update | A waiting worker shows nothing; it switches in on the next page change (full load of the target), not during a transfer | D-038 | PWA-4 |

## Legal and SEO

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Static legal pages | `/privacy`, `/terms`, `/acceptable-use`, `/subprocessors` return full HTML without JS (h1, > 2,000 characters of text, title, canonical) | D-016, owner | LEGAL-1, PROD-3 |
| Rendered and redirects | The pages render signed out with no errors. `/legal/<doc>` redirects. | D-016 | LEGAL-2 |
| robots / sitemap | Production: robots has `User-agent` and a `Sitemap`, and the sitemap lists the legal pages. Staging: robots is `Disallow: /`, no sitemap (404), and every response carries `X-Robots-Tag: noindex`. | owner | LEGAL-3, PROD-3 |
| Links | The login consent line and the plans page link the legal pages | D-016 | LEGAL-4 |
| www → apex | `https://www.rolling.actor/…` returns 301 to the apex with path and query kept | D-015 | PROD-3 |

## Production smoke (`full-prod`)

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| Health and test routes | `environment: production`. `/api/test/inbox` and `/api/test/plan` return 404. | D-015 | PROD-1 |
| Public pages | login, signup, upgrade and legal return 200 with no console errors; app routes bounce to login | D-015 | PROD-2 |
| Static legal, robots, www | See Legal | D-016 | PROD-3 |
| Public APIs | Providers (Google on), plans (`current: null`), `/api/me` 401, manifest | D-017 | PROD-4 |
| Admin grant locked | 401 without the owner token | cc5d49d | PROD-5 |
| Platform headers | Server-Timing and D1 bookmarks; Workers static assets with Early Hints | 135a3e7, 80f2792 | PROD-6 |

## Cross-cutting

| Feature | Acceptance checks | Source | Tests |
|---|---|---|---|
| No dead controls | On every page (Home, four tools, Templates, Assets, Public library, Activity, Upgrade, five settings sections, a canvas), every enabled button, tab, switch and menu item does something: DOM change, request, navigation, download or focus move. No console errors, no 5xx, no “not implemented” / “coming soon” text in toasts or dialogs. | owner | X-1 |
| Skeletons, not mock data | With the API slowed by 3 s, Home, Activity and Templates show skeletons or `aria-busy` and no demo literals | owner, HO | X-2 |
| Reduced motion | With `prefers-reduced-motion`, popovers, menus and dialogs have no transform transitions or animations (opacity only) | CLAUDE.md, HO Motion | X-3 |
| Focus rings | No ring after a mouse click in the Settings nav (or on any section); a ring after Tab | owner | X-4 |
| Accessibility smoke | axe-core (wcag2a/aa) finds no critical violations on the main pages; serious ones are listed | owner | X-5 |
