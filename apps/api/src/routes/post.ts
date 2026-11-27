/**
 * Post-production routes (D-033 .. D-037; docs/api.md → Post-production).
 * Mounted at `/api/canvases` (captions, extend, lip-sync, voiceover split),
 * `/api/post-jobs`, `/api/brand-kit` and `/api/assets` (resize). Thin: logic in
 * `../post/*` and PostWorkflow. Captions, resize and voiceover split are free
 * (pricing config `POST_PRODUCTION`); extend and lip-sync are runs: their quote
 * goes through RunConfirm and `POST …/start` like `POST /api/runs`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BrandKitInputSchema, familyFromFileName, fontFormatOf, fontSignatureOk, BRAND_LIMITS } from "@rolling/core/post";
import { CAPTION_STYLE_IDS } from "@rolling/core/timeline";
import { newId } from "@rolling/core/ids";
import { RESIZE_TARGETS, type ResizeTarget } from "@rolling/core/pricing/config";
import { requireMember, requireRole, requireUser } from "../auth/context";
import type { AppEnv } from "../env";
import { projectAccess, requireAuth, roomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { projectIdForCanvas } from "../do/ProjectRoom";
import { createCaptionJob, createResizeJob, loadPostJob, postJobView } from "../post/jobs";
import { quoteExtend, quoteLipSync, startPlaced } from "../post/placements";
import { splitVoiceover } from "../post/voiceover";
import { addBrandFont, brandKitView, loadBrandKit, putBrandKit, removeBrandFont } from "../post/brandKit";

const CanvasParam = z.object({ id: z.string().regex(/^cnv_[A-Za-z0-9]+$/) });
const ClipId = z.string().min(1).max(64);
const Id = z.string().min(1).max(80);
const Lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).max(35);

const CaptionBody = z.object({
  source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("timeline") }), z.object({ kind: z.literal("voice") }), z.object({ kind: z.literal("clip"), clipId: ClipId })]).default({ kind: "timeline" }),
  style: z.enum(CAPTION_STYLE_IDS).optional(),
  /** `auto` (default) detects the spoken language. */
  language: z.union([z.literal("auto"), Lang]).default("auto"),
  /** Replace captions already in the transcribed span (default), else keep them and skip overlapping cues. */
  replace: z.boolean().default(true),
  /** Only store the transcript (imported voiceover, for the agent); the timeline is untouched. */
  transcriptOnly: z.boolean().default(false),
});

const ExtendBody = z.object({
  clipId: ClipId,
  prompt: z.string().trim().min(1).max(2000),
  model: z.string().min(1).max(128).optional(),
  seconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(16).optional(),
});

const LipSyncBody = z.object({
  shotClipId: ClipId,
  voiceClipId: ClipId,
  pictureAssetId: Id.optional(),
  prompt: z.string().max(2000).optional(),
  model: z.string().min(1).max(128).optional(),
});

const StartBody = z.object({ quoteId: Id });
const SplitBody = z.object({ clipId: ClipId, assign: z.boolean().default(true), minSilence: z.number().min(0.1).max(5).optional(), noiseDb: z.number().min(-80).max(-10).optional() });

async function canvasAccess(c: Context<AppEnv>, canvasId: string) {
  const projectId = projectIdForCanvas(canvasId);
  if (!projectId) throw new ApiError(404, "NOT_FOUND", "Canvas not found");
  const auth = await requireAuth(c);
  const acc = await projectAccess(c, auth, projectId, "editor");
  return { auth, acc, projectId, caller: roomCaller(auth, acc) };
}

/** `/api/canvases/:id/…` */
export const canvasPost = new Hono<AppEnv>()
  .post("/:id/captions", validate("param", CanvasParam), validate("json", CaptionBody), async (c) => {
    const canvasId = c.req.valid("param").id;
    const { acc, projectId, caller } = await canvasAccess(c, canvasId);
    if (!acc.membership.plan) throw new ApiError(402, "NO_PLAN", "An active plan is required", { workspaceId: acc.project.workspace_id });
    const b = c.req.valid("json");
    const row = await createCaptionJob(c.env, { caller, projectId, canvasId, source: b.source, ...(b.style && { style: b.style }), language: b.language === "auto" ? null : b.language, replace: b.replace, transcriptOnly: b.transcriptOnly });
    return c.json({ job: postJobView(row) }, 202);
  })
  .post("/:id/extend/quote", validate("param", CanvasParam), validate("json", ExtendBody), async (c) => {
    const canvasId = c.req.valid("param").id;
    const auth = requireMember(c);
    const { projectId, caller } = await canvasAccess(c, canvasId);
    const b = c.req.valid("json");
    return c.json(await quoteExtend(c.env, auth, { caller, projectId, canvasId, clipId: b.clipId, prompt: b.prompt, ...(b.model && { model: b.model }), ...(b.seconds && { seconds: b.seconds }), ...(b.resolution && { resolution: b.resolution }) }));
  })
  .post("/:id/lipsync/quote", validate("param", CanvasParam), validate("json", LipSyncBody), async (c) => {
    const canvasId = c.req.valid("param").id;
    const auth = requireMember(c);
    const { projectId, caller } = await canvasAccess(c, canvasId);
    const b = c.req.valid("json");
    return c.json(await quoteLipSync(c.env, auth, { caller, projectId, canvasId, shotClipId: b.shotClipId, voiceClipId: b.voiceClipId, ...(b.pictureAssetId && { pictureAssetId: b.pictureAssetId }), ...(b.prompt && { prompt: b.prompt }), ...(b.model && { model: b.model }) }));
  })
  /** Starts an extend or lip-sync quote (same as `POST /api/runs`, plus its timeline placement). */
  .post("/:id/placed-runs", validate("param", CanvasParam), validate("json", StartBody), async (c) => {
    const canvasId = c.req.valid("param").id;
    const auth = requireMember(c);
    const { caller } = await canvasAccess(c, canvasId);
    return c.json(await startPlaced(c.env, auth, caller, canvasId, c.req.valid("json").quoteId), 201);
  })
  .post("/:id/voiceover/split", validate("param", CanvasParam), validate("json", SplitBody), async (c) => {
    const canvasId = c.req.valid("param").id;
    const { projectId, caller } = await canvasAccess(c, canvasId);
    const b = c.req.valid("json");
    return c.json(await splitVoiceover(c.env, { caller, projectId, canvasId, clipId: b.clipId, assign: b.assign, ...(b.minSilence && { minSilence: b.minSilence }), ...(b.noiseDb && { noiseDb: b.noiseDb }) }));
  });

/** `GET /api/post-jobs/:id`: status, progress and result of a caption, transcript or resize job. */
export const postJobs = new Hono<AppEnv>().get("/:id", validate("param", z.object({ id: z.string().regex(/^pjb_[A-Za-z0-9]+$/) })), async (c) => {
  const auth = requireUser(c);
  const row = await loadPostJob(c.env, c.req.valid("param").id);
  if (!row || !auth.memberships.some((m) => m.workspaceId === row.workspace_id)) throw new ApiError(404, "NOT_FOUND", "Job not found");
  return c.json({ job: postJobView(row) });
});

/**
 * `POST /api/assets/:id/resize { target: "1080p" | "4K", projectId?, nodeId? }`;
 * `POST /api/assets/:id/voice-rights`: the uploader attests “I have the rights to use this voice” (D-037).
 */
export const assetPost = new Hono<AppEnv>()
  .post("/:id/voice-rights", validate("param", z.object({ id: Id })), async (c) => {
    const auth = requireRole(c, "editor");
    const a = await c.env.DB.prepare("SELECT kind, meta FROM assets WHERE id = ? AND workspace_id = ?").bind(c.req.valid("param").id, auth.workspaceId).first<{ kind: string; meta: string | null }>();
    if (!a) throw new ApiError(404, "NOT_FOUND", "Asset not found");
    if (a.kind !== "audio") throw new ApiError(422, "VALIDATION_FAILED", "Only audio takes a voice rights note", { reason: "NOT_AUDIO" });
    let meta: Record<string, unknown> = {};
    try {
      meta = a.meta ? (JSON.parse(a.meta) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    if (!meta.voiceRights) meta.voiceRights = { by: auth.userId, at: Date.now() };
    await c.env.DB.prepare("UPDATE assets SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), c.req.valid("param").id).run();
    return c.json({ ok: true, voiceRights: meta.voiceRights });
  })
  .post(
  "/:id/resize",
  validate("param", z.object({ id: Id })),
  validate("json", z.object({ target: z.enum(Object.keys(RESIZE_TARGETS) as [ResizeTarget, ...ResizeTarget[]]), projectId: Id.optional(), nodeId: Id.optional() })),
  async (c) => {
    requireRole(c, "editor");
    const auth = requireMember(c);
    const b = c.req.valid("json");
    if (b.projectId) await projectAccess(c, auth, b.projectId, "editor");
    const row = await createResizeJob(c.env, { userId: auth.userId, workspaceId: auth.workspaceId, plan: auth.plan!, assetId: c.req.valid("param").id, target: b.target, ...(b.projectId && { projectId: b.projectId }), ...(b.nodeId && b.projectId && { nodeId: b.nodeId }) });
    return c.json({ job: postJobView(row) }, 202);
  },
);

/** `/api/brand-kit`: the current workspace's brand kit. */
export const brandKit = new Hono<AppEnv>()
  .get("/", async (c) => {
    const auth = requireUser(c);
    return c.json({ brandKit: await brandKitView(c.env, auth.workspaceId, await loadBrandKit(c.env, auth.workspaceId)) });
  })
  .put("/", validate("json", BrandKitInputSchema), async (c) => {
    const auth = requireRole(c, "editor");
    const kit = await putBrandKit(c.env, auth.workspaceId, auth.userId, c.req.valid("json"));
    return c.json({ brandKit: await brandKitView(c.env, auth.workspaceId, kit) });
  })
  /**
   * Font upload: the raw file as the body (`content-type` font/woff2|font/ttf|font/otf),
   * `x-file-name`, optional `x-font-family`, and `x-license-confirmed: true` (the uploader
   * confirms the license allows embedding in videos). At most 4 MB, 4 fonts.
   */
  .post("/fonts", async (c) => {
    const auth = requireRole(c, "editor");
    if (c.req.header("x-license-confirmed") !== "true") throw new ApiError(422, "VALIDATION_FAILED", "Confirm the font’s license allows this use", { reason: "LICENSE_REQUIRED" });
    const fileName = decodeURIComponent(c.req.header("x-file-name") ?? "").slice(0, 200);
    const format = fontFormatOf(fileName, c.req.header("content-type"));
    if (!fileName || !format) throw new ApiError(415, "VALIDATION_FAILED", "Upload a WOFF2, TTF or OTF font", { reason: "FONT_TYPE" });
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > BRAND_LIMITS.fontBytes) throw new ApiError(413, "VALIDATION_FAILED", "Fonts can be up to 4 MB", { reason: "TOO_LARGE", maxBytes: BRAND_LIMITS.fontBytes });
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > BRAND_LIMITS.fontBytes) throw new ApiError(413, "VALIDATION_FAILED", "Fonts can be up to 4 MB", { reason: "TOO_LARGE", maxBytes: BRAND_LIMITS.fontBytes });
    if (!fontSignatureOk(format, new Uint8Array(bytes.slice(0, 4)))) throw new ApiError(415, "VALIDATION_FAILED", "This file is not a font of that type", { reason: "FONT_TYPE" });
    const family = (decodeURIComponent(c.req.header("x-font-family") ?? "").trim() || familyFromFileName(fileName)).slice(0, 64);
    const kit = await addBrandFont(c.env, auth.workspaceId, auth.userId, { id: newId("brandFont"), family, fileName, format, size: bytes.byteLength, licenseConfirmed: true }, bytes);
    return c.json({ brandKit: await brandKitView(c.env, auth.workspaceId, kit) }, 201);
  })
  .delete("/fonts/:fontId", validate("param", z.object({ fontId: z.string().regex(/^fnt_[A-Za-z0-9]+$/) })), async (c) => {
    const auth = requireRole(c, "editor");
    const kit = await removeBrandFont(c.env, auth.workspaceId, auth.userId, c.req.valid("param").fontId);
    return c.json({ brandKit: await brandKitView(c.env, auth.workspaceId, kit) });
  });
