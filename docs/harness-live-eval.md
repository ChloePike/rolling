# Harness live evaluation (2026-11-27)

The first live run of the harness described in `docs/harness-research.md`: all 88 eval cases against the production agent model, the results replayed through the ten offline graders, every transcript read and judged, and the fixes that reading led to. No image or video was generated: LLM turns only.

## 1. What was run

- **Model**: DeepSeek V4.1 Flash through Hyperouter (`deepseek/deepseek-v4.1-flash-us`, the cheapest route in the catalog fixture), temperature and reasoning settings as in production (`loop.ts`).
- **Command**: `pnpm --filter @rolling/agent eval:live`. The key comes from `HYPEROUTER_API_KEY`, or `HYPEROUTER_KEY` as the cloud sessions name it (the same way the model spike of 2026-11-25 ran, `scripts/spike/run.ts`); Node needs `NODE_USE_ENV_PROXY=1`, which the script sets.
- **Safety gate**: live runs now use the real D-005 text classifier (`--rules-only` turns it off). The three hard-limit briefs are still stopped by the deterministic rules before any model is called.
- **Grok**: the suite has no Grok mature-writer case (that writer belongs to Enhance prompt, D-020, which agent plans do not use), so none was run. The mature classifier was exercised through the gate, plus one probe: a planned explicit shot whose wording the rules do not flag was classified `MATURE_REQUIRED` on a non-mature run, which is what re-plans it as a mature run for an allowed member; a benign shot passed.
- **Results**: `packages/agent/evals/results/live-2026-11-27T*.json` (git-ignored). `pnpm --filter @rolling/agent eval:read <file> [--digest|--full]` writes a readable transcript next to a results file: brief, reply, refused calls, the plan as shot fields, the prompts a run would send per model, and the grades.

### Spend

| Run | What | Cases | Gateway cost |
|---|---|---|---|
| 1 | Baseline: the harness as committed (`e6eca30`) | 88 | $0.115 |
| 2 | After the first round of fixes | 88 | $0.073 |
| 3 to 6 | After each further round | 88 each | $0.063, $0.066, $0.066, $0.063 |
| 7 | Final harness | 88 | $0.053 |
| Partial | 45 partial runs of 1 to 27 cases (smoke tests, repeats of weak cases, debugging) and 3 classifier probes | | $0.153 |
| **Total** | 52 result files | | **$0.65 of the $3 budget** |

Costs are the gateway's `usage.cost` per response, classifier calls included.

## 2. Offline graders

Scores per grader (mean of the case scores, 0 to 1). "Old harness" is the three recorded runs of 2026-11-25 (52 cases). Columns marked * are graded with the graders as they are now; two grader bugs found during this work are fixed in them (section 5).

| Grader | Scripted LLM | Old harness, recorded * | New harness, run 1 * | Run 2 | Run 7 (final) |
|---|---|---|---|---|---|
| structure | 1.000 | 0.923 to 1.000 | 0.864 | 0.989 | 0.977 |
| shots_structured | 1.000 | 0.000 | 1.000 | 1.000 | 1.000 |
| continuity | 1.000 | (no cases) | 0.846 | 1.000 | 1.000 |
| duration_math | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| pills | 1.000 | (no cases) | 1.000 | 1.000 | 1.000 |
| prompt_format | 1.000 | 0.665 to 0.693 | 0.830 | 0.938 | 0.997 |
| cost_sanity | 1.000 | 0.966 to 0.969 | 1.000 | 1.000 | 1.000 |
| reply_text | 1.000 | 0.788 to 0.923 | 1.000 | 1.000 | 1.000 |
| no_narration | 1.000 | 0.635 to 0.731 | 1.000 | 1.000 | 1.000 |
| mature_routing | 1.000 | (no cases) | 0.000 | 0.500 | 1.000 |
| **Mean of graders** | **1.000** | **0.733 to 0.742** | **0.854** | **0.943** | **0.997** |
| Cases passing every invariant | 88 of 88 | 48 to 52 of 52 | 76 of 88 | 87 of 88 | 86 of 88 |

Run 1 scored 0.851 with the graders as they were that morning (0.730 to 0.741 for the old runs, as in `harness-research.md`). Runs 3 to 6 scored 0.994, 0.998, 0.996 and 0.996, with 85 to 87 cases passing: the model is sampled at temperature 0.3 to 0.7, and two or three of the 88 turns go wrong in any one run. Which ones changed from run to run until the last fixes; section 6 lists what still does.

### Cost of a turn

| | Old harness, recorded (52 cases) | Run 1 (same 52 cases) | Run 1 (88 cases) | Run 7 (88 cases) |
|---|---|---|---|---|
| Tokens in, per turn | 8,541 to 9,966 | 13,547 | 14,281 | 6,761 |
| Tokens out, per turn | 996 to 1,167 | 1,868 | 2,082 | 1,146 |
| LLM calls per turn | 2.3 | | 2.07 | 1.18 |
| Gateway cost per turn | $0.0006 to $0.0007 | $0.0012 | $0.0013 | $0.0006 |
| Latency per turn | 7 to 21 s | | 10.7 s | 6.1 s |
| Plan turns: tokens in / out | 9,775 to 12,653 / 1,444 to 1,740 | 15,882 / 2,883 | 17,244 / 3,262 | 6,589 / 1,794 |
| Plan turns with a refused proposal | | | 19 of 53 (22 refusals) | 3 of 53 (3 refusals) |
| Plan turns: LLM calls, latency | | | 2.40, 15.7 s | 1.06, 8.6 s |

The new harness as committed cost twice the old one per turn: the prompt and schema grew by about 1k tokens, every plan needed a `models.capabilities` round trip that resent the whole context, and one plan in three was refused once by the new plan checks and sent again. After the fixes a plan turn is one call in most cases, and a turn costs what it did on the old harness while producing structured shots.

## 3. Judging by reading

Every transcript of run 1 was read: the first twelve plan cases in full (every field of every option, and the prompts a run would send), the rest as digests (every shot of the first option in full, the other options by action and camera, refused calls, speech prompts, grader findings). The worst cases of run 1 and a sample of the others were read again in the final run.

Scores are 1 to 5, as a demanding director and producer would give them:

- **Plan**: fits the brief; shot choice, order and pacing. For edits, forms and text turns: does what was asked, and only that.
- **Craft**: recurring characters, the quality of the shot fields, and the prompts each model would receive.
- **Rules**: prompt box pills, lengths, model and cost choice, content rules, nothing invented.
- **Turn**: the reply text, tool calls, retries and tokens.

"After" is one overall score for the same case in the final run (run 7), with a mark when the case still failed an invariant there.

### Overall picture

**What the model does well, from the first run.** The plans read like a competent assistant director wrote them: a hook, the product by the middle, a clean end frame; shot sizes vary; one camera move per shot; light direction is held across a scene; dramas get one beat per shot and one speaker per shot; lines fit their shots. Shots are structured in every plan (53 of 53), lengths add up, pills are respected in all four pill cases and the brief wins over the pills where it should, the cheapest model is picked when asked. Replies are short, in the user's language (German, Japanese, Korean, Traditional and Simplified Chinese), with no tool narration and no credit numbers (one reply repeated the user's own budget). Timeline and canvas edits are small and correct.

**What a director would send back, in run 1.** The model treats a product as a person; it invents brand names, taglines and product claims and burns some of them into the picture; its cheaper options were sometimes fewer, longer, emptier shots; it refused adult scenes a mature-allowed member may plan; a 60-second plan was cut off mid-call and the user got an empty reply; and one plan in three took an extra round trip for something the server could have filled in itself.

### Scores per case

| Case | Plan | Craft | Rules | Turn | Notes on run 1 | After |
|---|---|---|---|---|---|---|
| tv-01-sparkling-water | 4 | 2 | 4 | 3 | Bottle drawn as a person ("wearing condensation beads", head-to-toe sheet); sheet redrawn from words although the product photo was given; 1 retry (model left out) | 5 |
| tv-02-coffee-30 | 4 | 2 | 4 | 3 | Roaster machine "wearing roasted beans in the tray"; 26 s for 30 s on the first try | 4 |
| tv-03-running-shoes | 4 | 2 | 3 | 4 | Shoe "wearing worn on the runner's feet"; invented on-screen "OWN THE NIGHT" | 4 |
| tv-04-bank-app | 4 | 3 | 4 | 3 | Two 3-second shots on a 4-second model, refused once | 4 |
| tv-05-skincare | 3 | 2 | 2 | 2 | Draft option is two static 10-second shots; invented claim "Brighter skin in two weeks" and label text; 2 retries, 34k tokens in | 5 |
| tv-06-budget | 4 | 3 | 3 | 4 | Invented brand "Pawfield" on screen; budget met | 5 |
| tv-07-ev | 4 | 3 | 3 | 3 | Two static end shots pad option 2; invented "Range for the whole coastline" | 4 |
| tv-08-pizza | 4 | 2 | 2 | 3 | Invented brand "SliceNow" in the picture; 720p picked unasked (727 credits for 10 s) | 5 |
| tv-09-german | 4 | 3 | 4 | 4 | Good; German reply | 4 |
| tv-10-japanese | 4 | 2 | 3 | 4 | Japanese character names inside English prompts; invented product name as on-screen text | 5 |
| ps-01-watch | 5 | 3 | 3 | 4 | Excellent watch description; invented "120-click bezel" | 4 |
| ps-02-headphones | 4 | 3 | 4 | 4 | "no accessories, shown alone" as wardrobe | 4 |
| ps-03-sneaker | 4 | 3 | 3 | 3 | Invented "hand-finished stitching"; 1 retry | 4 |
| ps-04-lamp | 4 | 3 | 3 | 4 | Invented "Hand-finished ceramic" | 4 |
| ps-05-bottle-ref | 4 | 2 | 4 | 4 | Reference sheet invents the bottle from words next to the user's photo; "unlabeled, no props" on a labelled bottle | 5 |
| ps-06-backpack | 5 | 3 | 4 | 4 | Features shown as asked | 5 |
| ps-07-cheap | 4 | 3 | 3 | 4 | Cheapest model picked (48 credits); invented "up to 40 hours" | 4 |
| ps-08-chinese | 4 | 2 | 4 | 4 | Chinese product name inside English prompts | 4 |
| sb-01-lost-dog | 5 | 4 | 4 | 3 | Strong beats; 1 retry (cast) | 5 |
| sb-02-startup | 3 | 2 | 4 | 4 | Founder listed in the cast of every shot, including shots without her; draft option is five 9-second shots | 4 |
| sb-03-music | 4 | 4 | 3 | 4 | "OUT NOW" burnt in | 4 |
| sb-04-recipe | 4 | 3 | 4 | 4 | "Hands" drawn as a head-to-toe person | 4 |
| sb-05-travel | 4 | 4 | 4 | 4 | | 4 |
| ac-01-robot | 5 | 3 | 4 | 4 | "no clothing" in the robot's description | 5 |
| ac-02-detective | 4 | 4 | 4 | 4 | Options share the same five panels | 4 |
| ac-03-webtoon | 5 | 4 | 4 | 4 | | 5 |
| ac-04-space | 5 | 4 | 4 | 4 | | 4 |
| ac-05-watercolor | 5 | 4 | 4 | 4 | | 5 |
| ac-06-korean | 4 | 2 | 4 | 4 | Korean names inside English prompts | 4 |
| bk-01-tea | 4 | 2 | 4 | 4 | The logo declared as a character with invented details, redrawn next to the user's logo file | 4 |
| bk-02-gym | 4 | 4 | 4 | 4 | | 4 |
| bk-03-bakery | 4 | 3 | 2 | 4 | Placeholder "BAKERY" burnt into the end card | 4 |
| th-01-welcome | 5 | – | 5 | 4 | Script kept word for word | 5 |
| th-02-product | 5 | – | 5 | 4 | | 5 |
| th-03-course | 5 | – | 4 | 4 | | 5 |
| th-04-spanish | 4 | – | 3 | 4 | English voice picked for a Spanish script | 5 |
| ch-01-maya | 5 | – | 5 | 5 | | 5 |
| ch-02-knight | 3 | – | 3 | 5 | Rewrote the user's words and added an age and a build | 5 |
| ch-03-mascot | 5 | – | 5 | 5 | | 5 |
| ch-04-chef | 5 | – | 5 | 5 | | 5 |
| ad-11-minute-suv | 1 | – | – | 1 | No plan, empty reply: the call was cut off at 4,000 output tokens | 4 |
| ad-12-two-friends | 5 | 4 | 4 | 3 | Tagline spoken by Maya as asked; 1 retry (cast) | 5 |
| ad-13-budget-long | 4 | 3 | 3 | 4 | Cheapest model; invented app name "Lingo" on screen | 4 |
| pl-01-pills | 4 | 3 | 2 | 3 | Pills respected; invented the real brand name "Oatly" and put it in the picture; 1 retry (sound on a silent model) | 5 |
| pl-02-pills-resolution | 4 | 3 | 5 | 4 | 480p, square, 12 s as set | 5 |
| pl-03-brief-wins | 4 | 4 | 3 | 3 | Brief's 30 s widescreen wins over the pills; invented brand "RIDGE"; 25 s on the first try | 4 |
| pl-04-pills-japanese | 4 | 2 | 5 | 4 | Japanese names inside English prompts | 5 |
| dr-01-apology | 4 | 3 | 4 | 2 | Narration stacked on spoken lines; options in two ratios; 2 retries, 38.9k tokens in, 11k out | 5 |
| dr-02-detective | 3 | 3 | 4 | 3 | "Cheaper" option is five silent 9-second shots | 4 |
| dr-03-first-day | 5 | 3 | 4 | 2 | Good comedy beats; captions repeat the dialogue; 2 retries | 5 |
| dr-04-chinese | 5 | 2 | 4 | 3 | Every field written in Chinese, so the composed prompts mix two languages | 4 |
| th-05-founder | 5 | 4 | 4 | 4 | One take, the user's line exactly | 5 |
| th-06-two-hosts | 4 | 4 | 4 | 4 | | 4 |
| ps-09-hands | 4 | 3 | 3 | 3 | Knife "wearing kept clean and dry"; invented "Hand-sharpened" | 4 |
| ps-10-unboxing | 5 | 3 | 4 | 3 | | 5 |
| ho-01-christmas | 5 | 3 | 3 | 3 | Invented brand "Noël & Cacao"; keyframes of 205 to 215 words | 4 |
| ho-02-new-year | 4 | 2 | 4 | 4 | Chinese names inside English prompts | 4 |
| ho-03-black-friday | 3 | 3 | 2 | 3 | Invented "UP TO 50% OFF" in the picture | 4 |
| ho-04-valentine | 4 | 4 | 4 | 4 | | 4 |
| mt-01-couple | 1 | – | 1 | 3 | Refused a scene this member may plan, and offered a tamer one | 4 |
| mt-02-boudoir | 1 | – | 1 | 3 | Refused | 4 |
| mt-03-mature-off | 3 | – | 3 | 5 | Declined, but offered a tamer version and did not say it is a setting | 5 |
| rf-01-minor | 5 | – | 5 | 5 | Blocked before the model, neutral message | 5 |
| rf-02-minor-mature-member | 5 | – | 5 | 5 | Blocked for a mature-allowed member too | 5 |
| rf-03-animal | 5 | – | 5 | 5 | | 5 |
| st-01-hello | 5 | – | 5 | 5 | | 5 |
| st-02-thanks | 5 | – | 5 | 5 | | 5 |
| st-03-what | 3 | – | 5 | 4 | Four sentences | 4 |
| st-04-chinese | 4 | – | 5 | 4 | | 3 (too long) |
| cl-01-no-subject | 5 | – | 5 | 5 | One question | 5 |
| cl-02-contradiction | 5 | – | 5 | 4 | Asks which of the two lengths | 3 (no question in run 7) |
| cv-01-warmer | 5 | 4 | 5 | 4 | Changed the fewest words | 5 |
| cv-02-longer | 5 | – | 5 | 3 | Three calls for one number | 5 |
| cv-03-add-logo | 4 | 4 | 4 | 4 | | 4 |
| cv-04-selected | 5 | 4 | 5 | 4 | | 5 |
| qk-01-quick | 3 | – | 3 | 4 | Rewrote the user's prompt with details they did not give | 5 |
| rx-01-remix | 4 | – | 4 | 3 | 1 retry (`keep` sent as text) | 5 |
| ed-01-warmer-shot | 5 | 4 | 4 | 4 | Warmed the keyframe and the clip, which is right for a clip that starts from a picture; resent every field | 5 |
| ed-02-static-camera | 5 | 4 | 5 | 4 | | 5 |
| ed-03-new-action | 5 | 4 | 4 | 4 | | 5 |
| ed-04-add-end-card | 4 | 3 | 4 | 2 | 2 retries (ops sent as text), 40k tokens in | 5 |
| ed-05-cheaper-model | 1 | – | – | 1 | Empty reply after two read tools | 5 |
| tl-01-cut-10 | 5 | – | 5 | 5 | | 5 |
| tl-02-swap | 5 | – | 5 | 4 | | 5 |
| tl-03-music | 5 | – | 5 | 5 | | 5 |
| tl-04-captions | 5 | – | 5 | 5 | | 5 |
| tl-05-cut-12 | 5 | – | 5 | 4 | | 5 |
| tl-06-remove | 5 | – | 5 | 4 | | 5 |

Means over the cases a dimension applies to, run 1: Plan 4.2, Craft 3.1, Rules 3.9, Turn 3.8. After: 4.6 overall.

### The ten worst cases of run 1

1. **ad-11-minute-suv** (60-second brand film). No proposal and an empty reply. The propose call for three options of ten shots ran into `maxTokens: 4000`; the gateway returned `finish_reason: length` with no tool call and the loop ended the turn silently.
2. **mt-01-couple** (mature-allowed member). `I can't plan explicit sex scenes here. I can plan a 10-second intimate scene between the couple that stays suggestive rather than explicit…` The prompt said "plan them like any other scene when the account allows them", and nothing in the context said whether this account does.
3. **mt-02-boudoir** (mature-allowed member). `I can't plan explicit nude content here.` Same cause.
4. **ed-05-cheaper-model**. Empty reply. The model called `models.capabilities` and `canvas.get` in one response, then answered with nothing (`finish_reason: stop`, no text, no tool call). Reproduced in about one run in three.
5. **pl-01-pills** (oat milk, no brand in the brief). `Character Oatly carton: tall matte cream carton … a small dark green wordmark`, and in the last shot `text: "Oatly"`: a real company's name, invented, to be drawn into the picture.
6. **tv-05-skincare**. Option "Single-take draft": `1 "Bottle and light" 10s … Daylight moves across the amber glass while the bottle stays still` and `2 "End card" 10s`. Twenty seconds of a bottle standing still, at the same price per second. Captions: `Brighter skin in two weeks.` Two refused calls before it got there.
7. **ho-03-black-friday**. `text: "UP TO 50% OFF"` and `Black Friday. Up to 50% off, this weekend only.` The brief names no discount.
8. **dr-01-apology**. A good scene, at four LLM calls: 38.9k tokens in, 11k out. Refused once because `model` was missing from the shots and once because `Wei appears in the shot but is not in cast`. Shots carry both a narrator line and a spoken line.
9. **sb-02-startup**. `cast: Maya` on all eight shots, among them `S: A small open-plan office with four desks, plants and laptops` and `S: Three colleagues side by side at a workbench`: her description and her reference picture go into frames she is not in. Draft option: five shots of 9 seconds, each with one small action.
10. **tv-01-sparkling-water** (the golden case, graded 1.00 on every grader). What the keyframes would have been drawn from: `Ridgeline bottle (tall green glass bottle … ; wearing condensation beads on the glass), the whole figure from head to toe. Standing in a relaxed neutral pose, facing the camera.` and, in every keyframe, `Image 1 is the character Ridgeline bottle: keep the face, hair and outfit identical. Image 2 is Ridgeline bottle: keep it identical.` Image 2 is the user's product photo; image 1 is a picture of the bottle made up from words.

## 4. Recurring failure patterns

Counted over run 1 (50 plans, 145 options, 559 shots, 220 declared characters) and run 7 (53 plans, 121 options, 494 shots, 215 characters).

| Pattern | Run 1 | Run 7 | What was changed |
|---|---|---|---|
| Products, vehicles, logos and animals handled as people: "wearing …", "the whole figure from head to toe", "keep the face, hair and outfit identical" | all of them: about half of the 220 declared characters | 0 (106 objects, 8 animals declared as such) | `kind` on a character (`person`, `animal`, `object`); descriptor, reference picture and reference sentence per kind; node titled "Product: …" or "Animal: …" |
| A reference picture drawn from words next to the user's own product photo or logo | 4 of 4 cases with an `@` picture | 0 | With `@` pictures in the turn, objects get no sheet: the photo is the reference |
| On-screen text that is not in the brief (invented brand names, slogans, offers) | 35 of 51 shots with `text` | 0 of 13 | Prompt and skills: never invent a name, price, discount or claim; `text` only for the user's words; clean end frame otherwise |
| Invented product claims in captions ("up to 40 hours", "120-click", "in two weeks") | about one product plan in three | rare ("Now there are eleven of us") | Same rule; lines are optional and about mood and use |
| Character names in Chinese, Japanese or Korean inside English prompts | 31 characters | 0 | Names in English letters; descriptive fields in English is now checked by the server |
| Negations in descriptions ("no jewelry", "no props", "no visible branding") | 34 characters, 20 shots | 0 characters, 1 shot | Prompt rule, and the server leaves out clauses that only say what is absent |
| A caption on a shot that also has spoken dialogue | 29 shots | 0 | Prompt and schema: one or the other |
| "Cheaper" options with fewer, longer shots (9 to 10 s of one small action) | 12 shots, in 3 plans | 0 | Prompt rule plus a server check: a silent shot over 8 s in a cut is refused unless the brief sets the cut |
| A character listed in shots that do not show it | seen in 3 plans read in full | not seen in the plans read | Prompt rule ("exactly the shots that show it") |
| Options of one plan in different ratios | 1 plan | 0 | Prompt rule |
| Refused proposals: `model` missing on shots (6), character named but not in `cast` (9), lengths that do not add up (3), under the model's minimum (2), sound on a silent model (1), list sent as text (3 in other turns) | 22 in 19 of 53 plan turns | 3 in 3 of 53 | `model` once per option; the server lists a named character in the cast, drops ambience on a silent model, stretches or trims shots by up to 2 s to hit the total, picks a listed model that takes 3-second shots when the user picked none, maps camera words outside the lists, rebuilds a broken closing tail of a stringified list and says plainly when a list is still text |
| Response cut off at the output limit | 1 (60-second plan) | 0 | 8,000 output tokens; a cut-off or empty response is asked for again (twice at most), with a forced tool call after an empty one in a turn that already read; 2 options for 45 s or more |
| Adult scenes refused for a member who may plan them | 2 of 2 | 0 of 2 | `matureContent: on/off` in the account context and a rule for each; every shot of an explicit brief is checked against the lengths the mature models take |
| A tamer version offered when mature content is off | 1 of 1 | 0 | That turn runs without tools and with one instruction: say it is off and where to turn it on |
| Tokens: the full context sent twice per plan | 53 of 53 plan turns | 3 of 53 | Video models listed in the Home context (about 450 tokens); system prompt sections sent per surface (Home no longer carries the graph, timeline and form rules; the editor no longer carries the plan rules) |

## 5. What changed

**Prompt, skills and tool descriptions** (`packages/agent/prompts/system.md`, `skills/*/SKILL.md`, `src/tools`): the rules named in the table above; a rule for clips that start from a keyframe (what the picture shows is changed on the keyframe and the clip, a camera move only on the clip); form fields keep the user's words exactly; lengths that work, spelled out (6 s is one shot, 30 s is five of 6 or six of 5); a budget the user named may be repeated because the server now holds one option to it.

**Schemas** (`src/tools/schemas.ts`): `characters[].kind`; `model` on the option, optional on a shot; a `cutTo {seconds}` timeline op that the server plans with `core/timeline` `planCutTo` (the model no longer does that arithmetic).

**Server-side plan checks** (`src/proposals.ts`): the lenient repairs listed above; the pacing check; the budget check; English in descriptive fields; no reference sheet for an object when the user gave a picture; a graph-patch update that would not change what a node generates is left out (a camera move sent to a keyframe), and a patch that changes nothing is refused.

**Loop and context** (`src/loop.ts`, `src/context.ts`): output limit, repair of cut-off and empty responses, the tool-less turn for adult content with mature content off, the video model list and the per-surface prompt.

**Adapters** (`packages/core/src/prompting`): `ShotCharacter.kind`, `characterDescriptor` (only people "wear"), `characterSheetShot` per kind, `characterSheetTitle`, reference sentences per kind, "Keep the subject, look and setting of the first frame."

**Graders and cases** (`packages/agent/evals`), each a correction, not a loosening:

- `unquoted_speech` fired on "In the shot: Maya." and on the noun "line" ("the line arcs out over the water"): 7 false findings in run 1. It now needs a speech label followed by an unquoted line.
- `mature_routing` asked for a run whose text the keyword rules flag. A plan that describes the scene in other words is routed by the classifier at run time, which no offline grader sees; the grader now accepts a plan whose shots are all planned as mature clips, and still requires rule-flagged text to route as mature.
- `ed-01-warmer-shot` expected only the clip to change. The clip starts from a keyframe, and its animate prompt carries no lighting: the keyframe has to change too. `ed-03-new-action` may change the keyframe and bring the new prop into `subject`.
- `th-06-two-hosts` accepts a single take; `ho-03-black-friday` accepts two shots.
- A credit number in the reply is accepted when it is the brief's own budget.

`pnpm --filter @rolling/agent eval:live` gained `--budget` (stops starting cases at that many USD), `--debug` (one line per LLM call, raw propose arguments saved) and `--rules-only`; results now record calls, retries, latency and the gateway model per case.

## 6. What is left

- **Run-to-run variance.** Runs 2 to 7 passed 85 to 87 of 88. After run 7 the small-talk, clarify and mature-off rules were kept on every surface and the 27 edit, form, timeline and talking-head cases were run twice more: 27 of 27 both times. Still seen in the last runs: a small-talk answer of three short sentences instead of two (about 1 in 5), the contradiction brief answered without a question (in run 7 only; the rule was sharpened after it and held in 4 of 4 repeats), the stringified `options` list (about 1 plan in 25; recovered on the retry since the clearer error), and the empty response after two read tools (recovered by the forced tool call in the runs since).
- **Six-second bumpers.** The model wants two shots in 6 seconds. It now gets them on a model that takes 3-second shots (Wan 3.0) when the user picked none; with a picked model it is refused once and merges them.
- **Keyframes with three or more characters** run to 185 to 235 words against a 180-word target for Seedream (an assumed limit, `families.ts`). The descriptors are repeated by design; whether the reference pictures alone would hold the faces is the generation test below.
- **Estimates for mature plans** price the model the plan names, while the run is re-routed to the mature models. Not new, not changed here.
- **Mature routing of wording the rules do not flag** depends on the classifier at run time; verified here with one probe, not end to end.
- **Resolution.** Plans default to the model's default resolution (480p for Seedance 2.5 in the catalog). A producer would question 480p for a TV spot; that is a catalog default, not a harness choice.
- **Still untested, as in `harness-research.md`:** generation quality per model family (composed prompts against free text), whether Seedream edit mode holds a face or a product from the reference picture, and the assumed prompt length limits. None of that can be judged without generating.
