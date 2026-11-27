/**
 * Consistency check after a generation (D-032). Runs as its own step of the
 * GenerateWorkflow once the job is committed, never blocks or fails the job,
 * and costs the user nothing (gateway cost is logged like the safety checks):
 *
 * 1. Which characters the job drew from: sheet pictures among its inputs, or
 *    inherited through a keyframe that was drawn from a sheet (the output's
 *    `meta.characters`).
 * 2. Records "used in" for the project, and marks the output with those
 *    characters (so a video animated from it inherits them).
 * 3. People only: face-detect with head crops on the output (image, or the
 *    video's poster) and, cached per sheet version, on the front view; the
 *    vision model rates the heads; the score and verdict are stored in
 *    `character_checks`.
 */
import { CONSISTENCY_METHOD, compareFaces, detectHeads, driftVerdict, MAX_CANDIDATE_FACES, type DriftVerdict } from "@rolling/core/characters";
import type { GenInput } from "@rolling/core/generation";
import { newId } from "@rolling/core/ids";
import { visionModelsFor } from "@rolling/core/safety";
import { isRoomError } from "../lib/room";
import { gatewayFetch } from "../runs/provider";
import type { JobContext } from "../runs/jobs";
import { ports } from "../runs/ports";
import { r2Picture, safetyDeps } from "../safety/service";
import { getCharacter, parseJsonSafe, sheetLinks, sheetOf } from "./store";

/** At most this many characters are checked per output. */
const MAX_CHARACTERS = 3;

interface CharacterRef {
  characterId: string;
  version: number;
}

export interface ConsistencyResult {
  characters: number;
  checks: Array<{ characterId: string; score: number | null; verdict: DriftVerdict | "error" }>;
}

/** Asset ids of a job's image inputs (direct assets, upstream nodes' active outputs, earlier items of the run). */
async function inputAssetIds(env: Env, ctx: JobContext): Promise<string[]> {
  const out: string[] = [];
  let active: Record<string, string> | null = null;
  for (const input of ctx.spec.inputs as GenInput[]) {
    if (input.media !== "image") continue;
    if ("assetId" in input.from) out.push(input.from.assetId);
    else if ("item" in input.from) {
      const row = await env.DB.prepare("SELECT asset_id FROM jobs WHERE run_id = ? AND item_ref = ? AND status = 'succeeded' AND asset_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
        .bind(ctx.runId, input.from.item)
        .first<{ asset_id: string }>();
      if (row) out.push(row.asset_id);
    } else if ("node" in input.from && ctx.projectId) {
      if (!active) {
        const g = await ports(env).room(ctx.projectId).getGraph({ userId: ctx.createdBy, workspaceId: ctx.workspaceId, canEdit: true });
        active = isRoomError(g) ? {} : g.assets;
      }
      const id = active[input.from.node];
      if (id) out.push(id);
    }
  }
  return [...new Set(out)];
}

/** Characters of the job: sheet inputs first, then those inherited through generated inputs. */
async function charactersOf(env: Env, ctx: JobContext, inputs: readonly string[]): Promise<CharacterRef[]> {
  const found = new Map<string, CharacterRef>();
  for (const l of await sheetLinks(env, ctx.workspaceId, inputs)) if (!found.has(l.characterId)) found.set(l.characterId, { characterId: l.characterId, version: l.version });
  if (inputs.length > 0) {
    const rows = (
      await env.DB.prepare(`SELECT meta FROM assets WHERE id IN (${inputs.map(() => "?").join(",")}) AND workspace_id = ?`).bind(...inputs, ctx.workspaceId).all<{ meta: string | null }>()
    ).results;
    for (const r of rows) {
      for (const c of parseJsonSafe<{ characters?: CharacterRef[] }>(r.meta, {}).characters ?? []) {
        if (typeof c?.characterId === "string" && typeof c.version === "number" && !found.has(c.characterId)) found.set(c.characterId, { characterId: c.characterId, version: c.version });
      }
    }
  }
  return [...found.values()].slice(0, MAX_CHARACTERS);
}

function bytesOfDataUrl(url: string): { bytes: Uint8Array; contentType: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const raw = m[2] ? atob(m[3]!) : decodeURIComponent(m[3]!);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, contentType: m[1] ?? "image/jpeg" };
}

function dataUrlOf(bytes: Uint8Array, contentType: string): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${contentType};base64,${btoa(s)}`;
}

/** A head crop the gateway returned, as an inline picture (the vision model never needs to reach the gateway's storage). */
async function inlineHead(url: string): Promise<{ url: string; bytes: Uint8Array; contentType: string } | null> {
  if (url.startsWith("data:")) {
    const d = bytesOfDataUrl(url);
    return d ? { url, ...d } : null;
  }
  try {
    const res = await gatewayFetch()(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 2_000_000) return null;
    return { url: dataUrlOf(bytes, contentType), bytes, contentType };
  } catch {
    return null;
  }
}

/** The reference head of a character's current sheet (cached in R2 per version). */
async function referenceHead(env: Env, ctx: JobContext, characterId: string, llm: NonNullable<Awaited<ReturnType<typeof safetyDeps>>["llm"]>): Promise<{ url: string; costUsd: number } | null> {
  const row = await getCharacter(env, ctx.workspaceId, characterId);
  if (!row) return null;
  if (row.ref_face_key) {
    const obj = await env.MEDIA.get(row.ref_face_key);
    if (obj) return { url: dataUrlOf(new Uint8Array(await obj.arrayBuffer()), obj.httpMetadata?.contentType ?? "image/jpeg"), costUsd: 0 };
  }
  const views = sheetOf(row);
  const frontId = views.front ?? views.full_body ?? row.cover_asset_id;
  if (!frontId) return null;
  const asset = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(frontId).first<{ r2_key: string }>();
  const pic = asset ? await r2Picture(env, asset.r2_key) : null;
  if (!pic) return null;
  const found = await detectHeads(llm, pic.url, `chk_ref_${characterId}_${pic.hash.slice(0, 16)}`);
  const head = found.heads.find((h) => h.url);
  // No crop came back: the whole front view is the reference.
  const inline = head?.url ? await inlineHead(head.url) : null;
  const key = `ws/${ctx.workspaceId}/characters/${characterId}/ref-face-${pic.hash.slice(0, 16)}`;
  if (inline) {
    await env.MEDIA.put(key, inline.bytes, { httpMetadata: { contentType: inline.contentType } });
    await env.DB.prepare("UPDATE characters SET ref_face_key = ? WHERE id = ?").bind(key, characterId).run();
  }
  return { url: inline?.url ?? pic.url, costUsd: found.costUsd ?? 0 };
}

/** The picture of the output to check: the image itself, or the video's poster. */
async function outputPicture(env: Env, assetId: string): Promise<{ url: string; hash: string } | null> {
  const row = await env.DB.prepare("SELECT kind, r2_key, meta FROM assets WHERE id = ?").bind(assetId).first<{ kind: string; r2_key: string; meta: string | null }>();
  if (!row) return null;
  const key = row.kind === "image" ? row.r2_key : parseJsonSafe<{ thumbKey?: string }>(row.meta, {}).thumbKey;
  return key ? r2Picture(env, key) : null;
}

async function store(
  env: Env,
  ctx: JobContext,
  c: CharacterRef,
  assetId: string,
  r: { score: number | null; verdict: DriftVerdict | "error"; faces: number; model: string | null; costUsd: number; error?: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO character_checks (id, workspace_id, character_id, version, asset_id, run_id, job_id, project_id, score, verdict, faces, method, model, cost_usd, error, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM character_checks WHERE job_id = ? AND character_id = ?)`,
  )
    .bind(
      newId("event").replace(/^[a-z]+_/, "chk_"),
      ctx.workspaceId,
      c.characterId,
      c.version,
      assetId,
      ctx.runId,
      ctx.jobId,
      ctx.projectId,
      r.score,
      r.verdict,
      r.faces,
      CONSISTENCY_METHOD,
      r.model,
      r.costUsd,
      r.error ?? null,
      Date.now(),
      ctx.jobId,
      c.characterId,
    )
    .run();
  try {
    (env as { AE?: { writeDataPoint(p: unknown): void } }).AE?.writeDataPoint({ indexes: [ctx.workspaceId], blobs: ["character_check", r.verdict, r.model ?? ""], doubles: [r.score ?? -1, r.costUsd] });
  } catch {
    // Analytics never breaks a check.
  }
}

/** The check for one committed job. Errors are stored as `error` checks; nothing is thrown. */
export async function checkCharacterConsistency(env: Env, ctx: JobContext): Promise<ConsistencyResult> {
  // Nothing drawn from a picture: no character sheet can be involved (no queries).
  if (!(ctx.spec.inputs as GenInput[]).some((i) => i.media === "image")) return { characters: 0, checks: [] };
  const job = await env.DB.prepare("SELECT asset_id FROM jobs WHERE id = ?").bind(ctx.jobId).first<{ asset_id: string | null }>();
  const assetId = job?.asset_id;
  if (!assetId) return { characters: 0, checks: [] };
  // A sheet run's own pictures are the reference, not a use of it.
  const run = await env.DB.prepare("SELECT tool FROM runs WHERE id = ?").bind(ctx.runId).first<{ tool: string | null }>();
  if (run?.tool === "character") return { characters: 0, checks: [] };
  const inputs = await inputAssetIds(env, ctx);
  const chars = await charactersOf(env, ctx, inputs);
  if (chars.length === 0) return { characters: 0, checks: [] };
  const now = Date.now();
  // The output carries its characters (a video animated from this keyframe inherits them) and "used in" is recorded.
  const statements = [env.DB.prepare("UPDATE assets SET meta = json_set(COALESCE(meta, '{}'), '$.characters', json(?)) WHERE id = ?").bind(JSON.stringify(chars), assetId)];
  if (ctx.projectId) {
    for (const c of chars) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO character_uses (character_id, project_id, workspace_id, uses, last_used_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (character_id, project_id) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at",
        ).bind(c.characterId, ctx.projectId, ctx.workspaceId, now),
      );
    }
  }
  await env.DB.batch(statements);

  const people: CharacterRef[] = [];
  for (const c of chars) {
    const row = await getCharacter(env, ctx.workspaceId, c.characterId);
    if (row && (row.kind ?? "person") === "person") people.push(c);
  }
  const checks: ConsistencyResult["checks"] = [];
  if (people.length === 0) return { characters: chars.length, checks };
  const deps = await safetyDeps(env);
  const record = async (c: CharacterRef, r: Parameters<typeof store>[4]) => {
    await store(env, ctx, c, assetId, r);
    checks.push({ characterId: c.characterId, score: r.score, verdict: r.verdict });
  };
  if (!deps.llm) {
    for (const c of people) await record(c, { score: null, verdict: "error", faces: 0, model: null, costUsd: 0, error: "gateway not configured" });
    return { characters: chars.length, checks };
  }
  let models: string[] = [];
  try {
    models = visionModelsFor(deps.chatModels);
  } catch {
    models = [];
  }
  const pic = await outputPicture(env, assetId);
  if (!pic) {
    for (const c of people) await record(c, { score: null, verdict: "error", faces: 0, model: null, costUsd: 0, error: "no picture to check" });
    return { characters: chars.length, checks };
  }
  let heads: string[] = [];
  let faces = 0;
  let detectCost = 0;
  try {
    const found = await detectHeads(deps.llm, pic.url, `chk_out_${ctx.jobId}`);
    faces = found.heads.length;
    detectCost = found.costUsd ?? 0;
    for (const h of found.heads.slice(0, MAX_CANDIDATE_FACES)) {
      const inline = h.url ? await inlineHead(h.url) : null;
      if (inline) heads.push(inline.url);
    }
    // Faces found but no crop came back: compare the whole picture.
    if (faces > 0 && heads.length === 0) heads = [pic.url];
  } catch (err) {
    for (const c of people) await record(c, { score: null, verdict: "error", faces: 0, model: "lumina/face-detect", costUsd: 0, error: String(err).slice(0, 200) });
    return { characters: chars.length, checks };
  }
  for (const [i, c] of people.entries()) {
    const cost0 = i === 0 ? detectCost : 0;
    if (faces === 0) {
      await record(c, { score: null, verdict: "no_face", faces: 0, model: "lumina/face-detect", costUsd: cost0 });
      continue;
    }
    try {
      const ref = await referenceHead(env, ctx, c.characterId, deps.llm);
      if (!ref) {
        await record(c, { score: null, verdict: "error", faces, model: null, costUsd: cost0, error: "no reference face" });
        continue;
      }
      const m = await compareFaces(deps.llm, models, ref.url, heads, `chk_cmp_${ctx.jobId}_${c.characterId}`);
      await record(c, { score: m.score, verdict: driftVerdict(m.score), faces, model: m.model, costUsd: cost0 + ref.costUsd + (m.costUsd ?? 0) });
    } catch (err) {
      await record(c, { score: null, verdict: "error", faces, model: models[0] ?? null, costUsd: cost0, error: String(err).slice(0, 200) });
    }
  }
  return { characters: chars.length, checks };
}

/** Workflow step body: never throws (a failed check must not touch the committed job). */
export async function consistencyStep(env: Env, ctx: JobContext): Promise<{ characters: number; checks: number; drift: number }> {
  try {
    const r = await checkCharacterConsistency(env, ctx);
    return { characters: r.characters, checks: r.checks.length, drift: r.checks.filter((c) => c.verdict === "drift").length };
  } catch (err) {
    console.error(JSON.stringify({ msg: "characters: consistency check failed", jobId: ctx.jobId, error: String(err) }));
    return { characters: 0, checks: 0, drift: 0 };
  }
}
