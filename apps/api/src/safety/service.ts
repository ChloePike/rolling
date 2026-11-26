/**
 * D-005 safety layer, Worker side: builds the core safety deps (chat adapter,
 * chat catalog, D1 verdict cache), logs events (D1 `safety_events` + Analytics
 * Engine), flags workspaces after repeated hard-limit blocks, and prepares
 * media for the classifiers (R2 bytes → small `data:` URLs, so the gateway
 * never needs to reach our private media).
 *
 * Nothing here can turn a check off: there is no setting, variable or plan
 * that skips `preCheck` / `postCheck`.
 */
import { hyperouter } from "@rolling/core";
import {
  FLAG_THRESHOLD,
  FLAG_WINDOW_MS,
  HARD_LIMIT_CODES,
  excerptOf,
  isMatureRating,
  rateMedia,
  type SafetyCode,
  type SafetyDeps,
  type SafetyEvent,
  type SafetyVerdict,
  type VerdictCache,
  createSafetyGate,
  detectUploadFaces,
  FACE_DETECT_MODEL,
  type FaceResult,
  type SafetyGate,
} from "@rolling/core/safety";
import { newId } from "@rolling/core/ids";
import { loadCatalog } from "../models/catalog";
import { gatewayConfigured, hyperouterClient } from "../runs/provider";

/** Cached assessments live 30 days (content hash + prompt version keyed). */
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** Largest picture sent inline to a classifier. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export function d1VerdictCache(env: Env): VerdictCache {
  return {
    async get(key) {
      const row = await env.DB.prepare("SELECT value FROM safety_cache WHERE key = ? AND expires_at > ?").bind(key, Date.now()).first<{ value: string }>();
      return row ? (JSON.parse(row.value) as unknown) : null;
    },
    async put(key, value) {
      await env.DB.prepare("INSERT OR REPLACE INTO safety_cache (key, value, expires_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), Date.now() + CACHE_TTL_MS).run();
    },
  };
}

let llmOverride: ((env: Env) => SafetyDeps["llm"]) | null = null;

/** Tests: replace the chat adapter the safety layer uses (null restores the gateway). */
export function setSafetyLlmForTests(fn: ((env: Env) => SafetyDeps["llm"]) | null): void {
  llmOverride = fn;
}

/** Core deps. Without a configured gateway the LLM is null: mature runs then fail closed. */
export async function safetyDeps(env: Env): Promise<SafetyDeps> {
  const llm = llmOverride ? llmOverride(env) : gatewayConfigured(env) ? new hyperouter.HyperouterLlmProvider(hyperouterClient(env)) : null;
  let chatModels: SafetyDeps["chatModels"] = [];
  try {
    chatModels = (await loadCatalog(env, "chat")).models;
  } catch (err) {
    console.error(JSON.stringify({ msg: "safety: chat catalog unavailable", error: String(err) }));
  }
  return { llm, chatModels, cache: d1VerdictCache(env), newKey: () => `safety_${newId("event")}` };
}

interface AnalyticsLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

export interface LogInput {
  /** Deterministic id (dedupes step retries), e.g. `<jobId>:pre:<model>`. */
  id?: string;
  workspaceId: string;
  userId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  stage: SafetyEvent["stage"];
  verdict: SafetyVerdict;
  prompt?: string | null;
}

/** Codes of a verdict, plus outage markers from failed checks on allowed runs. */
function codesOf(v: SafetyVerdict): SafetyCode[] {
  const codes = v.reasons.map((r) => r.code);
  if (v.verdict === "allow" && v.checks.some((c) => c.status === "error")) codes.push("SAFETY_UNAVAILABLE");
  return codes;
}

/** True when the event is worth logging: a block, or a classifier outage. */
export function shouldLog(v: SafetyVerdict): boolean {
  return v.verdict === "block" || v.checks.some((c) => c.status === "error");
}

/**
 * Logs one event (D1 + Analytics Engine). Hard-limit blocks count toward the
 * review flag: FLAG_THRESHOLD of them in 24 h set `workspaces.safety_flag`.
 * Returns whether the workspace is (now) flagged.
 */
export async function logSafety(env: Env, input: LogInput): Promise<{ flagged: boolean }> {
  const codes = codesOf(input.verdict);
  const hard = input.verdict.verdict === "block" && codes.some((c) => HARD_LIMIT_CODES.has(c));
  const model = input.verdict.checks.find((c) => c.model)?.model ?? null;
  const now = Date.now();
  const id = input.id ? `sev_${input.id}` : newId("event").replace(/^[a-z]+_/, "sev_");
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO safety_events (id, workspace_id, user_id, run_id, job_id, stage, verdict, codes, model, excerpt, hard, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, input.workspaceId, input.userId ?? null, input.runId ?? null, input.jobId ?? null, input.stage, input.verdict.verdict, JSON.stringify(codes), model, excerptOf(input.prompt), hard ? 1 : 0, now)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ msg: "safety: event insert failed", error: String(err) }));
  }
  try {
    const ae = (env as { AE?: AnalyticsLike }).AE;
    const cost = input.verdict.checks.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    ae?.writeDataPoint({ indexes: [input.workspaceId], blobs: ["safety", input.stage, input.verdict.verdict, codes.join(","), model], doubles: [hard ? 1 : 0, cost] });
  } catch {
    // Analytics never breaks a check.
  }
  console.warn(JSON.stringify({ msg: "safety: event", stage: input.stage, verdict: input.verdict.verdict, codes, workspaceId: input.workspaceId, jobId: input.jobId ?? null }));
  if (!hard) return { flagged: false };
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE workspace_id = ? AND hard = 1 AND created_at > ?")
    .bind(input.workspaceId, now - FLAG_WINDOW_MS)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= FLAG_THRESHOLD) {
    await env.DB.prepare("UPDATE workspaces SET safety_flag = 1, safety_flagged_at = COALESCE(safety_flagged_at, ?) WHERE id = ?").bind(now, input.workspaceId).run();
    return { flagged: true };
  }
  return { flagged: false };
}

/** D-005: a flagged workspace has mature runs refused until review clears it. */
export async function workspaceFlagged(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT safety_flag FROM workspaces WHERE id = ?").bind(workspaceId).first<{ safety_flag: number }>();
  return row?.safety_flag === 1;
}

export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A picture as a classifier input: downscaled to a JPEG (≤ 1024 px, Images
 * binding) when possible, else the original when it is small enough. JPEG
 * also suits `lumina/face-detect` (JPEG or PNG only). Null when too large.
 */
export async function pictureDataUrl(env: Env, bytes: ArrayBuffer, contentType: string): Promise<string | null> {
  try {
    const out = (await env.IMAGES.input(new Blob([bytes]).stream()).transform({ width: 1024, fit: "scale-down" }).output({ format: "image/jpeg", quality: 85 })).response();
    const jpeg = await out.arrayBuffer();
    if (jpeg.byteLength > 0 && jpeg.byteLength <= MAX_INLINE_BYTES) return `data:image/jpeg;base64,${base64(new Uint8Array(jpeg))}`;
  } catch {
    // Images binding unavailable (tests, local): fall back to the original.
  }
  if (bytes.byteLength > MAX_INLINE_BYTES || !contentType.startsWith("image/")) return null;
  return `data:${contentType};base64,${base64(new Uint8Array(bytes))}`;
}

/** An R2 picture as a classifier input with its content hash. */
export async function r2Picture(env: Env, key: string): Promise<{ url: string; hash: string } | null> {
  const obj = await env.MEDIA.get(key);
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  const url = await pictureDataUrl(env, bytes, obj.httpMetadata?.contentType ?? "application/octet-stream");
  return url ? { url, hash: await sha256OfBytes(bytes) } : null;
}

/**
 * Face metadata of an upload (`assets.meta.faces`, D-005 / UP-4): from `lumina/face-detect` on the image, or on
 * a video's poster frame. `status: "unavailable"` when detection could not run; such an upload is never
 * treated as face-free: a mature run that uses it detects again and fails closed if it still cannot.
 */
export type StoredFaces =
  | { status: "done"; count: number; maxConfidence: number; boxes?: FaceResult["boxes"]; apparentMinor: boolean | null; model: string; source: "image" | "poster"; at: number }
  | { status: "unavailable"; reason: string; source: "image" | "poster"; at: number };

/** The stored face metadata as a FaceResult for the safety checks (null unless detection ran). */
export function faceResultFromMeta(meta: unknown): FaceResult | null {
  const f = (meta as { faces?: Partial<StoredFaces> } | null)?.faces;
  if (!f || f.status !== "done" || typeof f.count !== "number") return null;
  return { faces: f.count, maxConfidence: typeof f.maxConfidence === "number" ? f.maxConfidence : 0, ...(f.boxes && { boxes: f.boxes }), apparentMinor: f.apparentMinor ?? null };
}

/**
 * Upload hook for the `media.process` consumer (M3): rates a ready asset and
 * stores `rating`, `rating_confidence`, `rating_model` and the derived
 * `mature` flag (D-005 visibility). Images are rated from their bytes, videos
 * from `meta.thumbKey` (the poster frame) when present. Uploads also get face
 * detection on the same picture (`meta.faces`, see StoredFaces), which feeds the
 * minor and real-person rules here and in later runs. An upload that shows a
 * hard-limit violation is marked `failed` (never usable as an input) and logged
 * with stage `upload`. Unrated (classifier down) leaves the columns untouched.
 */
export async function rateAsset(env: Env, assetId: string): Promise<{ rating: string | null; blocked: boolean; faces?: StoredFaces }> {
  const row = await env.DB.prepare("SELECT id, workspace_id, kind, source, r2_key, meta, created_by FROM assets WHERE id = ?").bind(assetId).first<{
    id: string;
    workspace_id: string | null;
    kind: string;
    source: string;
    r2_key: string;
    meta: string;
    created_by: string | null;
  }>();
  if (!row || (row.kind !== "image" && row.kind !== "video")) return { rating: null, blocked: false };
  let meta: { thumbKey?: string } = {};
  try {
    meta = JSON.parse(row.meta) as { thumbKey?: string };
  } catch {
    // keep empty
  }
  const pictureKey = row.kind === "image" ? row.r2_key : meta.thumbKey;
  const picture = pictureKey ? await r2Picture(env, pictureKey) : null;
  const deps = await safetyDeps(env);
  const source = row.source === "generated" ? "generated" : "upload";

  // Face detection on uploads (generated media has no real face to protect; platform assets are curated).
  let faces: StoredFaces | undefined;
  let face: FaceResult | null = null;
  const isUpload = row.source === "mine" || row.source === "team";
  if (isUpload && (row.kind === "image" || pictureKey)) {
    const faceSource = row.kind === "image" ? "image" : "poster";
    const at = Date.now();
    const detected = picture ? await detectUploadFaces(picture, deps) : ({ ok: false, note: "picture unavailable" } as const);
    if (detected.ok) {
      face = detected.value;
      faces = {
        status: "done",
        count: face.faces,
        maxConfidence: face.maxConfidence,
        ...(face.boxes && { boxes: face.boxes }),
        apparentMinor: face.apparentMinor ?? null,
        model: FACE_DETECT_MODEL,
        source: faceSource,
        at,
      };
    } else {
      faces = { status: "unavailable", reason: detected.note, source: faceSource, at };
      console.warn(JSON.stringify({ msg: "safety: upload face detection unavailable", assetId, reason: detected.note }));
    }
    // Merge into the current meta (processing may have written since we read it).
    await env.DB.prepare("UPDATE assets SET meta = json_set(COALESCE(meta, '{}'), '$.faces', json(?)) WHERE id = ?").bind(JSON.stringify(faces), assetId).run();
  }

  const verdict = await rateMedia(
    row.kind === "image"
      ? { kind: "image", source, face, ...(picture && { url: picture.url, hash: picture.hash }) }
      : { kind: "video", source, face, frames: picture ? [picture.url] : [], ...(picture && { hash: picture.hash }) },
    deps,
  );
  const blocked = verdict.verdict === "block" && verdict.reasons.some((r) => HARD_LIMIT_CODES.has(r.code));
  const rating = verdict.rating ?? null;
  const pending = (meta as { reviewPending?: unknown }).reviewPending === true;
  if (rating && pending) {
    // A generated clip that waited for review (D-005): rated now, visibility follows the rating as at `store`.
    await env.DB.prepare("UPDATE assets SET rating = ?, rating_confidence = ?, rating_model = ?, mature = ?, meta = json_remove(meta, '$.reviewPending') WHERE id = ?")
      .bind(rating.rating, rating.confidence, rating.model, isMatureRating(rating.rating) ? 1 : 0, assetId)
      .run();
  } else if (rating) {
    await env.DB.prepare("UPDATE assets SET rating = ?, rating_confidence = ?, rating_model = ?, mature = CASE WHEN ? THEN 1 ELSE mature END WHERE id = ?")
      .bind(rating.rating, rating.confidence, rating.model, isMatureRating(rating.rating) ? 1 : 0, assetId)
      .run();
  }
  if (blocked) await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = ?").bind(assetId).run();
  if (row.workspace_id && shouldLog(verdict)) {
    await logSafety(env, { id: `${assetId}:upload`, workspaceId: row.workspace_id, userId: row.created_by, stage: "upload", verdict });
  }
  return { rating: rating?.rating ?? null, blocked, ...(faces && { faces }) };
}

/**
 * The agent harness gate (M6): briefs at the start of each turn, proposals'
 * generation prompts before they are shown. Blocks and outages are logged
 * with stage `agent`.
 */
export async function agentSafetyGate(env: Env, caller: { userId: string; workspaceId: string }): Promise<SafetyGate> {
  return createSafetyGate(await safetyDeps(env), async (verdict, _what, excerpt) => {
    if (shouldLog(verdict)) await logSafety(env, { workspaceId: caller.workspaceId, userId: caller.userId, stage: "agent", verdict, prompt: excerpt });
  });
}
