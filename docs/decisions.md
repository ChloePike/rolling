# Decisions log

Decisions made after the original spec. Where this file disagrees with `PRD.md`, `architecture.md`, `api.md` or `harness.md`, this file wins. Newest first.

## D-006 — Pricing: credits are the product, plans are the entry ticket (2026-11-25)

Owner decisions: gross margin ≥ 50%; revenue comes mainly from credit purchases; plans exist to unlock membership (which is also the age gate, D-005). The Hyperouter 5.5% top-up fee is ignored. Values live in `packages/core/pricing/config.ts`; tests enforce the margin floor.

- **Credit unit:** 1 credit = $0.01 retail. `credits = ceil(gatewayUsd × 3.0 ÷ 0.01)` (3× markup on live list price, per resolution and length). Example: Seedance 2.5 720p 5 s = 347 credits.
- **Plans (entry ticket, small grant, perks):**

| Plan | Monthly | Yearly (−20%) | Credits/month | Pack discount | Jobs at once | Max res | Voice clone | Seats |
|---|---|---|---|---|---|---|---|---|
| Starter | $5 | $48 | 200 | 0% | 2 | 1080p | no | 1 |
| Pro | $15 | $144 | 800 | 5% | 5 | 4K | yes | 1 |
| Studio | $49 | $470 | 2,500 | 10% | 10 | 4K | yes | 10 |

- **Packs (members only, never expire):** $10 → 1,000 · $25 → 2,600 · $50 → 5,500 · $100 → 11,500 · $250 → 28,500. The largest pack is capped so the largest member discount still clears 50%.
- **Margin floor (all credits used, after card fees ~4.65% + $0.30 and 2% infra):** packs 50.4–57.5%, plans 70–76%. Real usage below 100% raises it.
- **Confirm threshold** default becomes 300 credits (≈ $3), the PRD’s “20 credits” rescaled. **Auto top-up:** below 200 credits buy the $10 pack.
- Supersedes the PRD placeholders for plan credits, plan prices, yearly discount, pack prices and per-model credit prices.

## D-005 — Adult (18+) content is allowed (2026-11-25)

The platform allows 18+ creation for paying members. This replaces the PRD line “compliance/moderation work beyond what providers enforce” being out of scope.

- **Access = paid membership.** No date-of-birth or separate age verification. Paying (an active plan via Stripe) is treated as the age gate: 18+ generation is available only to workspaces with an active subscription. Non-members and lapsed members get `moderation: "auto"` routing only. A per-user preference `prefs.matureContent` (default off) controls whether mature models and outputs are shown — it is a visibility preference, not verification. Workspaces can disable it for all members (`workspaces.matureAllowed`).
- **Regional risk (open).** Some jurisdictions (e.g. UK Online Safety Act, several US states) require “highly effective” age assurance for adult content; card payment may not satisfy it everywhere (debit/prepaid cards). Revisit per launch region; keep a `AgeAssurance` hook point in the run path so a region-specific check can be added without redesign.
- **Hard limits, never configurable:** no sexual content involving minors or anyone who appears to be a minor; no sexual or intimate content depicting a real, identifiable person (uploaded face photos, celebrity names) — real-person references are allowed only for non-sexual content. These run as a pre-submit check on prompts and references (`packages/core/safety`) and as a post-generation check on outputs; violations block the run, release the hold, and are logged for review.
- **Provider routing.** Hyperouter `moderation: "low"` is enabled on the account (2026-11-25). Mature runs go only to models flagged `mature: true` (the `lumina/*-spicy` family and any model whose listing supports the `moderation` parameter) in `packages/core/models/capabilities`, with Hyperouter `moderation: "low"`; everything else uses `moderation: "auto"`. Provider rejections (`content_rejected`, `vendor_rejected`) release the hold like any failure.
- **Identity-driven models** (face/head swap, photo-driven i2v and lip-sync) are never used for mature runs with an uploaded photo. Mature photo-driven runs are allowed only when every input image is a platform asset (generated on Rolling, a saved Character, or a public-library item); uploaded photos are rejected for mature runs. Face/head swap is never mature.
- **Visibility.** Mature outputs are blurred in lists until clicked, never shown on public share links, profiles, templates or the public library, and never used as thumbnails in shared surfaces.
- **Payments risk (open).** Stripe’s restricted-business list covers adult content. Confirm with Stripe before launch; keep the payment layer behind `packages/core/billing/PaymentProvider` so a second processor can be added. Until confirmed, no Stripe-facing copy mentions adult content.

## D-004 — PoseWear content is the public library (2026-11-25)

Source: https://posewear.pages.dev/ (data index at `/assets/poses.<hash>.json`, images on `pwimg.0vo.pro`). Categories and counts at import time:

| Group | Category (zh) | Key | Count | License |
|---|---|---|---|---|
| Pose | 姿势 | `pose` | 288 | First-party |
| Pose | 深度姿势 | `pose_depth` | 288 | First-party |
| Character look | 人像 | `portrait` | 1499 | CC0 |
| Character look | 表情 | `expression` | 95 | MIT |
| Character look | 发型 | `hairstyle` | 122 | CC0 |
| Wardrobe | 服装 | `outfit` | 1407 | First-party |
| Wardrobe | 动画服装 | `outfit_anime` | 1760 | First-party |
| Wardrobe | 历代服饰 | `outfit_historical` | 57 | CC0 |
| Scene & props | 场景 | `scene` | 64 | CC0 |
| Scene & props | 光影 | `lighting` | 50 | CC0 |
| Scene & props | 道具 | `prop` | 32 | CC0 |
| Scene & props | 家具 | `furniture` | 41 | CC0 |

- An import script (`packages/db/scripts/import-posewear.ts`) reads the JSON index, copies images into R2 (`public/<category>/<id>/…`), and upserts `public_items` rows (+ `assets` with source `public`, + `asset_search` FTS) in D1 with category, sub-category, tags, prompt text, license and source URL. It is idempotent and re-runnable.
- **Rights.** The owner holds authorization from the upstream author (@giaaibusi) for the pose, depth-pose, outfit and anime-outfit galleries (confirmed 2026-11-25). CharaDB-hosted images (all hairstyles, 440 anime outfits) are NOT covered — CharaDB allows tags/prompts only — so they are excluded from R2 (`--exclude-attribution charadb`) until we have permission or regenerate them; their metadata may still be used.
- **PoseWear is our own property** (confirmed by the owner, 2026-11-25). Items the PRD marked “Rights reserved” (poses, depth poses, outfits, anime outfits) are first-party: license value `first-party`, no warning label, no replacement needed before launch. This supersedes PRD rule 9’s “replace before paid launch”. CC0 and MIT items keep their labels.
- Items are referenceable through `@` (Public library tab) and usable as references in generation: poses and depth poses as pose/control references, outfits/hairstyles/expressions/portraits as image references plus their prompt text.

## D-003 — API style: REST commands, WebSocket-first realtime, GraphQL reads (2026-11-25)

- **REST** (`/api/*`, Hono + Zod) for commands and anything with side effects: auth, billing, checkout, runs (quote/start/cancel), uploads, proposal apply/discard, webhooks. The REST table in `api.md` stays the command contract.
- **WebSocket** is the default channel for live state. One socket per open project (`/api/projects/:id/ws` → ProjectRoom) carries graph and timeline patches in both directions, job progress, node versions, proposals, agent token streams and presence. One user socket (`/api/ws` → a per-user `UserHub` Durable Object) carries credits changes, Activity updates, notifications and Home agent streams. Agent message streaming uses the socket, not SSE. Every WS message is a Zod-validated envelope `{ type, id, payload }`; client→server patches get `ack { id, revision }` or `conflict { id, snapshot }`.
- **GraphQL** (`/api/graphql`, GraphQL Yoga on Workers) for read-heavy, nested queries: projects list, assets and `@` picker search, public library, templates, Activity with filters, ledger. Read-only (no mutations), persisted queries in production, depth/complexity limits, same auth context as REST.

## D-002 — Hyperouter is the single model gateway (2026-11-25)

All LLM and generation calls go through Hyperouter (`https://api.hyperouter.app/v1`, `Authorization: Bearer sk-hr-v1-…`, docs https://hyperouter.app/docs). One provider adapter: `packages/core/models/providers/hyperouter/*`.

- **Agent LLM:** `deepseek/deepseek-v4.1-flash` via `/v1/chat/completions` (OpenAI-compatible, tools, SSE). `models` fallback list allowed.
- **Video:** `POST /v1/videos` (always async) → poll `GET /v1/videos/{id}` or webhook `video.completed|failed` → `GET /v1/videos/{id}/content`.
- **Image:** `POST /v1/images/generations|edits` with `Prefer: respond-async` → `GET /v1/generations/{id}` or webhook `image.completed|failed`.
- **Webhooks:** Standard Webhooks signing (`webhook-id`, `webhook-timestamp`, `webhook-signature` = `v1,` + base64 HMAC-SHA256 of `id.timestamp.body`, secret `whsec_…`). Payload carries only `data.id`; fetch the object after verifying. Dedupe on `webhook-id`.
- **Idempotency:** `Idempotency-Key` on every paid create (our job id); 30-minute window.
- Output URLs expire (images 24 h signed, video content 15 min); the `store` step copies to R2 immediately.

Launch model mapping (PRD → Hyperouter):

| PRD model | Hyperouter id | Status |
|---|---|---|
| Seedance 2.5 | `bytedance/seedance-2.5` | available (default video) |
| MiniMax H3 | `minimax/minimax-h3` | available |
| Wan 3.0 | `alibaba/wan3.0` | available |
| Wan 2.2 (cheap/fast) | `bytedance/seedance-2.0-mini` or `-fast` | substitute, confirm |
| Seedream 5.0 Pro | — | not listed; `bytedance/seedream-5.0-lite` is the default until available |
| Seedream 5.0 Lite | `bytedance/seedream-5.0-lite` / `-flash` | available |
| Wan 2.7 Image | `qwen/qwen-image-2.0` | substitute, confirm |
| Avatar lip-sync | `lumina/wan2.7-i2v-spicy` (photo + audio_url) | candidate |
| TTS, voice clone | — | **open**: owner is sourcing a provider |

**Model catalog is driven by the live listing** (owner decision, 2026-11-25): `GET /v1/models` is the source of truth for available models, durations, resolutions, reference limits and USD prices. A scheduled sync stores it in D1; the model picker, Auto selection and quotes read the synced catalog. PRD limits (e.g. 30s Seedance, MiniMax audio) are superseded by what the listing says. Our own overlay adds product fields only (display name, tags, default flags, `mature`, `requiresIdentitySafety`, hidden).

**Credits follow live cost**: `credits = ceil(usdCost(model, seconds, resolution, audio, refs) × markup ÷ usdPerCredit)`, with `markup` and `usdPerCredit` placeholders in `packages/core/pricing/config.ts`. This gives per-resolution prices automatically.

## D-001 — Language (2026-11-25)

All code, comments, commit messages, docs written for the repo, and identifiers are in English. Conversation with the user is in Chinese. UI copy source is English (`messages/en.json`).
