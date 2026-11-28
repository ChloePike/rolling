# PRD — Rolling (working name)

AI video studio. A user describes a video; an agent turns it into a plan of shots and nodes on a canvas; the user approves; models generate images, video and voice; an editor assembles the cut; the user exports. Global, English first, web + PWA.

Full feature table (128 rows with status, priority, competitor reference, in Chinese): https://claude.ai/artifact/25R3XjmfRic4PxTjNao1rz (download as CSV/XLSX from the page if needed). This file is the build scope.

## Users

- Solo creators making short social videos and ads.
- Small brand and agency teams (2–10 people) sharing one credit budget.

## Surfaces

| Surface | What it is |
|---|---|
| Home | One prompt box with four modes: Agent, Image, Video, Avatar. Model pill, `+` menu, `/` commands, `@` references. Recent projects, templates. |
| Canvas | Infinite node canvas. Script, text, image, video, audio, asset nodes. Agent panel on the right. Run node / selection / whole graph with a quote first. |
| Quick Create | Template-driven: pick a template, swap characters, lines and settings, generate. |
| Remix | Upload a reference video, recreate its shots with new characters and outfit. |
| Avatar | Talking-head video: avatar, persona, voice, script, camera. |
| Characters | Generate a consistent character (full body + face) and save to the library. |
| Editor | Premiere-style timeline: bin, program monitor, inspector, tracks (captions, video, voice, music). |
| Assets | My assets, Characters, Voices, Public library (PoseWear-based). |
| Templates | Browse and use templates. |
| Activity | Every run with status and cost; refunds shown. |
| Account | Log in / sign up, Upgrade (plans), Settings, Profile. |

## Scope by priority

### P0 — launch
- Auth: Google, Apple, email one-time code.
- Membership gate and plans (Starter, Plus, Pro; monthly or yearly) via Stripe. Any-amount credit top-ups for members (see `docs/decisions.md` D-006).
- Credit ledger: quote, hold, settle, release; plan credits first, purchased after; failed and canceled runs refunded.
- Paywall dialogs: “Pick a plan to generate” (non-member), “Not enough credits” (member), with the run continuing after payment.
- Home prompt box with modes, model picker, `/` command palette, `+` menu, `@` reference picker (my assets, characters, voices, team, public library).
- Canvas: nodes (text, script, image, video, audio, asset), edges with type checks, versions and “input changed” staleness, run node / selection / run all with a quote dialog, activity drawer, autosave.
- Agent on canvas: brief → plan options → user approves → nodes created (no spend) → user runs. Agent edits nodes on request with a visible diff.
- Quick Create, Remix, Avatar, Characters tools in Simple mode (chat-like) and Advanced mode (more settings), switch in Settings.
- Model gateway with the launch models (below) and Auto model selection.
- Assets library, Characters library, Voices (built-in voices; voice cloning on Pro and up).
- Activity page with costs and refunds.
- Settings: account, preferences (language, currency, creation mode, default aspect ratio, default model, confirm threshold), plan and billing (plan, credits, buy credits, auto top-up, payment method, invoices), team (members, roles, monthly limits), notifications.
- English UI, locale-aware numbers, dates and currency.

### P1
- Editor: agent auto-assembles a cut from the script (shots in order, voiceover, captions from the script, music with ducking); manual trim/split/move; agent edit commands with a proposal the user applies; regenerate a single shot in place; export MP4 1080p.
- Public library browsing with license labels.
- Templates authoring (save selection as template).
- Read-only share links.
- PWA install, offline page, silent updates (D-038).
- Locales: ja, zh-TW, zh-HK, ko.
- Motion spec applied across the app.
- Auto top-up.

### P2
- Profile page with published work.
- More locales: id, th, vi, es, pt-BR, de, fr, zh-CN.
- Real-time collaboration, community publishing, API/MCP.

Out of scope: native apps, phone-specific layouts, compliance/moderation work beyond what providers enforce, regional payment methods beyond Stripe.

## Launch models

| Use | Model | Notes |
|---|---|---|
| Agent (planning, scripts, edits) | DeepSeek | OpenAI-compatible chat + tool calling |
| Video | Seedance 2.5 | Default. Omni reference, first/last frame, up to 30s, audio |
| Video | MiniMax H3 | 2K, native audio, up to 9 image + 3 video + 3 audio refs, up to 15s |
| Video | Wan 3.0 | Docs/web pages to video, extend, up to 30s, 1080p |
| Video | Wan 2.2 | Cheap and fast, 720p, up to 5s |
| Image | Seedream 5.0 Pro | Default. Native 2K, 4K upscale, multilingual text |
| Image | Seedream 5.0 Lite | Fast, reference edits |
| Image | Wan 2.7 Image | Color accuracy, personal styles |
| Avatar | MiniMax H3 | Native audio, lip sync |
| Avatar | Wan 2.2 S2V | Photo + audio driven, cloned voices |

## Business rules

1. **Membership gate.** (Updated by `docs/decisions.md` D-007: the agent is members-only.) Without an active plan a user can browse and use templates’ previews; using the agent or generating requires a plan. Any action that costs credits opens “Pick a plan to generate”. The brief and the agent’s plan are kept and the run resumes after checkout.
2. **Credits.** One unit, called “credits” in every language (TW/HK UI shows 點數). Prices per model are per 5 seconds of video or per image, set in config.
3. **Order of spending.** Plan credits first (expire on the next billing date, no rollover), then purchased credits (never expire).
4. **Quote → hold → settle.** Each run gets a quote valid 10 minutes. Starting it places a hold equal to the quote. Success settles the actual amount (≤ hold). Failure or cancel releases the hold. Partial graph runs settle per node.
5. **Confirm threshold.** Runs at or above the user’s threshold (default 20 credits) show the confirm dialog; smaller ones start directly. Run-all always shows the plan.
6. **Not enough credits.** Show needed / balance / short-by, offer packs or an upgrade, then continue the same run. Optional auto top-up: below 200, buy 1,000 with the saved card.
7. **Teams (Pro).** One shared pool. Owner sets per-member monthly limits and roles (Owner, Editor, Viewer).
8. **Refunds are automatic** for failed or canceled provider jobs, shown in Activity and as a toast.
9. **Public library.** (Superseded in part by `docs/decisions.md` D-004: PoseWear is first-party, so its poses and outfits are not “Rights reserved”.) Items carry a license label. Poses and outfits from PoseWear are “Rights reserved” (original authors’ copyright); portraits, hairstyles, historical outfits, scenes, lighting, props and furniture are CC0; expressions are MIT. Surface the label; replace “Rights reserved” items with our own generated assets before paid launch.

## Open decisions

- Product name and domain (Rolling is a placeholder).
- Plan prices and yearly discount (`$[PRICE]`, `[DISCOUNT]` in designs).
- Credits per plan (placeholder 1,000 / 3,000 / 10,000) and per-plan perks (jobs at once, 4K, voice cloning tiers).
- Credit pack prices.
- Per-model credit prices (placeholders in designs: Seedance 2.5 8 / 5s, MiniMax H3 6 / 5s, Wan 3.0 7 / 5s, Wan 2.2 2 / 5s, Seedream Pro 3 / image, Lite 1, Wan 2.7 Image 2).
- Credit-to-USD rate.
