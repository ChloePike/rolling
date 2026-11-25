# Decisions log

Decisions made after the original spec. Where this file disagrees with `PRD.md`, `architecture.md`, `api.md` or `harness.md`, this file wins. Newest first.

## D-005 — Adult (18+) content is allowed (2026-11-25)

The platform allows 18+ creation for verified adults. This replaces the PRD line “compliance/moderation work beyond what providers enforce” being out of scope.

- **Age gate.** Users confirm date of birth at sign-up; 18+ content is off by default and enabled per user in Settings → Preferences (`prefs.matureContent`, requires age ≥ 18). Workspaces can disable it for all members (`workspaces.matureAllowed`).
- **Hard limits, never configurable:** no sexual content involving minors or anyone who appears to be a minor; no sexual or intimate content depicting a real, identifiable person (uploaded face photos, celebrity names) — real-person references are allowed only for non-sexual content. These run as a pre-submit check on prompts and references (`packages/core/safety`) and as a post-generation check on outputs; violations block the run, release the hold, and are logged for review.
- **Provider routing.** Mature runs go only to models flagged `mature: true` in `packages/core/models/capabilities`, with Hyperouter `moderation: "low"`; everything else uses `moderation: "auto"`. Provider rejections (`content_rejected`, `vendor_rejected`) release the hold like any failure.
- **Visibility.** Mature outputs are blurred in lists until clicked, never shown on public share links, profiles, templates or the public library, and never used as thumbnails in shared surfaces.
- **Payments risk (open).** Stripe’s restricted-business list covers adult content. Confirm with Stripe before launch; keep the payment layer behind `packages/core/billing/PaymentProvider` so a second processor can be added. Until confirmed, no Stripe-facing copy mentions adult content.

## D-004 — PoseWear content is the public library (2026-11-25)

Source: https://posewear.pages.dev/ (data index at `/assets/poses.<hash>.json`, images on `pwimg.0vo.pro`). Categories and counts at import time:

| Group | Category (zh) | Key | Count | License |
|---|---|---|---|---|
| Pose | 姿势 | `pose` | 288 | Rights reserved |
| Pose | 深度姿势 | `pose_depth` | 288 | Rights reserved |
| Character look | 人像 | `portrait` | 1499 | CC0 |
| Character look | 表情 | `expression` | 95 | MIT |
| Character look | 发型 | `hairstyle` | 122 | CC0 |
| Wardrobe | 服装 | `outfit` | 1407 | Rights reserved |
| Wardrobe | 动画服装 | `outfit_anime` | 1760 | Rights reserved |
| Wardrobe | 历代服饰 | `outfit_historical` | 57 | CC0 |
| Scene & props | 场景 | `scene` | 64 | CC0 |
| Scene & props | 光影 | `lighting` | 50 | CC0 |
| Scene & props | 道具 | `prop` | 32 | CC0 |
| Scene & props | 家具 | `furniture` | 41 | CC0 |

- An import script (`packages/db/scripts/import-posewear.ts`) reads the JSON index, copies images into R2 (`public/<category>/<id>/…`), and upserts `public_library` rows in D1 with category, sub-category, tags, prompt text, license and source URL. It is idempotent and re-runnable.
- Licenses per PRD rule 9 (verify per item where the source says otherwise). “Rights reserved” items get the yellow label and must be replaced with our own assets before paid launch.
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
| Avatar (MiniMax H3, Wan 2.2 S2V), TTS, voice clone | — | **open**: Hyperouter has no speech/lip-sync endpoint |

Credits are priced from Hyperouter USD costs via `packages/core/pricing/config.ts` (placeholder margin). Ids and prices must be confirmed against `GET /v1/models` at build time.

## D-001 — Language (2026-11-25)

All code, comments, commit messages, docs written for the repo, and identifiers are in English. Conversation with the user is in Chinese. UI copy source is English (`messages/en.json`).
