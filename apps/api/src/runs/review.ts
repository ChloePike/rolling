/**
 * Result review in the Generate workflow (D-024): after `store`, a cheap
 * vision-capable chat model reviews each output (image, or two frames of a
 * clip) against the prompt, the declared characters and their reference
 * pictures. The verdict is stored on the job (`jobs.review`), each asset
 * (`meta.review`) and the node version (`output.review`); the best take of a
 * multi-take run becomes the version's asset. A bad verdict offers "Retry
 * with fix"; in Auto mode (D-021) the job retries once per node within the
 * turn's budget, and the better of the two versions stays current.
 *
 * The review never fails a job: any error leaves the output unreviewed.
 * Its gateway cost is covered from the margin (`QUALITY_REVIEW`), never held
 * or charged.
 */
import { hyperouter, type LlmProvider } from "@rolling/core";
import { DEFAULT_PREFS } from "@rolling/core/auth/prefs";
import type { GenInput } from "@rolling/core/generation";
import { keyBelongsTo } from "@rolling/core/media";
import {
  decideRetry,
  fixParams,
  pickCurrent,
  reviewOutputs,
  type ResultReview,
  type ReviewAction,
  type ReviewInput,
  type ReviewMode,
  type ReviewTake,
} from "@rolling/core/review";
import { buildContext } from "../auth/context";
import { loadAccount } from "../auth/workspace";
import { matureAllowedIn, projectRoom } from "../lib/access";
import { isRoomError } from "../lib/room";
import { loadCatalog } from "../models/catalog";
import { pictureDataUrl, r2Picture } from "../safety/service";
import { extractFrames } from "./frames";
import { gatewayConfigured, hyperouterClient } from "./provider";
import { quoteRun, startRun, type ServerRunOptions } from "./service";
import { ports, quietly } from "./ports";
import { getRun, parseJson, type RunOptions } from "./store";
import type { JobContext, Stored } from "./jobs";

let llmOverride: ((env: Env) => LlmProvider | null) | null = null;

/** Tests: the chat adapter the review uses (null restores the default). */
export function setReviewLlmForTests(fn: ((env: Env) => LlmProvider | null) | null): void {
  llmOverride = fn;
}

/** The review's chat adapter: the gateway; none with `RESULT_REVIEW=off` (tests that do not fake the reviewer). */
function reviewLlm(env: Env): LlmProvider | null {
  if (llmOverride) return llmOverride(env);
  if (env.RESULT_REVIEW === "off" || !gatewayConfigured(env)) return null;
  return new hyperouter.HyperouterLlmProvider(hyperouterClient(env));
}

/** Settings → Preferences → Review results (`user_prefs.review_results`, on by default). */
export async function reviewResultsOn(env: Env, userId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT review_results FROM user_prefs WHERE user_id = ?").bind(userId).first<{ review_results: number | null }>();
    return row?.review_results === undefined || row.review_results === null ? DEFAULT_PREFS.reviewResults : row.review_results === 1;
  } catch {
    return DEFAULT_PREFS.reviewResults;
  }
}

const FRAME_TIMEOUT_MS = 30_000;
const FRAME_WIDTH = 640;

/** Seconds of a clip to review: early, middle and late, two of them (flicker hints come from frames that disagree). */
export function reviewFrameTimes(durationSec: number | undefined): number[] {
  const d = durationSec && durationSec > 0 ? durationSec : 5;
  if (d < 1) return [Math.round((d / 2) * 100) / 100];
  return [Math.round(Math.min(0.5, d / 4) * 100) / 100, Math.round(d * 0.75 * 100) / 100];
}

interface AssetRow {
  id: string;
  r2_key: string;
  meta: string | null;
  content_type: string | null;
}

async function takeOf(env: Env, ctx: JobContext, row: AssetRow, index: number): Promise<ReviewTake | null> {
  const meta = parseJson<{ width?: number; height?: number; thumbKey?: string }>(row.meta, {});
  if (ctx.spec.kind === "image") {
    const pic = await r2Picture(env, row.r2_key);
    return pic ? { pictures: [pic.url], ...(meta.width && meta.height && { width: meta.width, height: meta.height }) } : null;
  }
  const base = `ws/${ctx.workspaceId}/gen/${ctx.jobId}/${index}`;
  const frames = await extractFrames(env, { r2_key: row.r2_key, workspace_id: ctx.workspaceId }, reviewFrameTimes(ctx.spec.seconds), (at) => `${base}.review-${Math.round(at * 1000)}.png`, {
    width: FRAME_WIDTH,
    timeoutMs: FRAME_TIMEOUT_MS,
  });
  const pictures: string[] = [];
  for (const f of frames ?? []) {
    const pic = await pictureDataUrl(env, f.bytes, "image/png");
    if (pic) pictures.push(pic);
  }
  // No container: the poster stands in (one frame, no flicker hint).
  if (pictures.length === 0 && typeof meta.thumbKey === "string" && keyBelongsTo(meta.thumbKey, ctx.workspaceId)) {
    const pic = await r2Picture(env, meta.thumbKey);
    if (pic) pictures.push(pic.url);
  }
  return pictures.length ? { pictures } : null;
}

/** Image inputs the run declared as references or first frames (characters, products), as inline pictures. */
async function referencesOf(env: Env, ctx: JobContext): Promise<{ label: string; url: string }[]> {
  const inputs = (ctx.spec.inputs as GenInput[]).filter((i) => i.media === "image" && (i.role === "reference" || i.role === "frame"));
  if (inputs.length === 0) return [];
  let graphAssets: Record<string, string> = {};
  if (inputs.some((i) => "node" in i.from) && ctx.projectId) {
    const g = await ports(env).room(ctx.projectId).getGraph({ userId: ctx.createdBy, workspaceId: ctx.workspaceId, canEdit: false });
    if (!isRoomError(g)) graphAssets = g.assets;
  }
  const out: { label: string; url: string }[] = [];
  for (const input of inputs.slice(0, 2)) {
    const assetId = "node" in input.from ? graphAssets[input.from.node] : "assetId" in input.from ? input.from.assetId : undefined;
    if (!assetId) continue;
    const row = await env.DB.prepare("SELECT r2_key, workspace_id, kind FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string; workspace_id: string | null; kind: string }>();
    if (!row || row.kind !== "image" || (row.workspace_id !== null && row.workspace_id !== ctx.workspaceId)) continue;
    const pic = await r2Picture(env, row.r2_key);
    if (pic) out.push({ label: input.label ?? (input.role === "frame" ? "First frame" : "Reference"), url: pic.url });
  }
  return out;
}

/**
 * The `review` step: reviews the stored outputs and records the verdict on the
 * job and the assets. Null when the preference is off, nothing could be
 * reviewed or the reviewer failed (logged, never thrown).
 */
export async function reviewJob(env: Env, ctx: JobContext, stored: Stored, expandedPrompt: string | null): Promise<ResultReview | null> {
  try {
    const done = await env.DB.prepare("SELECT review FROM jobs WHERE id = ?").bind(ctx.jobId).first<{ review: string | null }>();
    if (done?.review) return parseJson<ResultReview | null>(done.review, null);
    if (!(await reviewResultsOn(env, ctx.createdBy))) return null;
    const llm = reviewLlm(env);
    if (!llm || stored.assetIds.length === 0) return null;
    const rows = (
      await env.DB.prepare(`SELECT id, r2_key, meta, content_type FROM assets WHERE id IN (${stored.assetIds.map(() => "?").join(",")})`)
        .bind(...stored.assetIds)
        .all<AssetRow>()
    ).results;
    const ordered = stored.assetIds.map((id) => rows.find((r) => r.id === id)).filter((r): r is AssetRow => !!r);
    const takes: ReviewTake[] = [];
    for (const [i, row] of ordered.slice(0, 4).entries()) {
      const t = await takeOf(env, ctx, row, i);
      if (!t) break;
      takes.push(t);
    }
    if (takes.length === 0) return null;
    const shot = ctx.spec.shot;
    const input: ReviewInput = {
      kind: ctx.spec.kind,
      prompt: ctx.spec.prompt,
      expandedPrompt,
      ...(ctx.spec.negativePrompt && { negativePrompt: ctx.spec.negativePrompt }),
      ...(ctx.spec.ratio && { ratio: ctx.spec.ratio }),
      ...(ctx.spec.seconds && { seconds: ctx.spec.seconds }),
      count: ctx.spec.n ?? stored.assetIds.length,
      characters: (shot?.characters ?? []).map((c) => ({ name: c.name, look: c.look, ...(c.wardrobe && { wardrobe: c.wardrobe }) })),
      references: await referencesOf(env, ctx),
      takes,
      ...(shot?.text && { requiredText: shot.text }),
    };
    const chat = (await loadCatalog(env, "chat")).models;
    const review = await reviewOutputs(llm, chat, input, `${ctx.jobId}.review`);
    await saveReview(env, ctx.jobId, review, ordered.slice(0, takes.length).map((r) => r.id));
    console.log(JSON.stringify({ msg: "review: done", jobId: ctx.jobId, model: review.model, score: review.score, takes: review.takes.length, costUsd: review.costUsd }));
    return review;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "review: skipped", jobId: ctx.jobId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return null;
  }
}

async function saveReview(env: Env, jobId: string, review: ResultReview, assetIds: readonly string[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET review = ?, review_cost_usd = ? WHERE id = ?").bind(JSON.stringify(review), review.costUsd, jobId),
    ...assetIds.map((id, i) =>
      env.DB.prepare("UPDATE assets SET meta = json_set(COALESCE(meta, '{}'), '$.review', json(?)) WHERE id = ?").bind(JSON.stringify({ ...review.takes[i], best: i === review.best }), id),
    ),
  ]);
}

export type ReviewRunOptions = RunOptions & ServerRunOptions;

/**
 * The credits an Auto retry may still hold now (before review retries): the turn's budget minus every run the
 * agent started in that turn (their quoted credits), else the snapshot taken when this run started.
 */
async function autoCap(env: Env, options: ReviewRunOptions): Promise<number> {
  const auto = options.auto!;
  if (auto.turnId && typeof auto.turnBudget === "number") {
    const row = await env.DB.prepare("SELECT COALESCE(SUM(credits_quoted), 0) AS spent FROM runs WHERE json_extract(options, '$.auto.turnId') = ?").bind(auto.turnId).first<{ spent: number }>();
    return Math.max(0, auto.turnBudget - (row?.spent ?? 0));
  }
  return Math.max(0, auto.budgetLeft);
}

async function runOptions(env: Env, runId: string): Promise<ReviewRunOptions> {
  const run = await getRun(env.DB, runId);
  return parseJson<ReviewRunOptions>(run?.options, {});
}

/** The `review-decide` step: what the review means for this job (stored on the job; the version gets it at commit). */
export async function decideReview(env: Env, ctx: JobContext, review: ResultReview): Promise<ResultReview> {
  const options = await runOptions(env, ctx.runId);
  const mode: ReviewMode = options.auto ? "auto" : "edit";
  const budgetKey = options.auto?.turnId ?? ctx.runId;
  let nodeRetried = false;
  let budgetLeft: number | null = null;
  if (options.auto && ctx.nodeId) {
    const used = await env.DB.prepare("SELECT COALESCE(SUM(credits), 0) AS used, SUM(CASE WHEN node_id = ? THEN 1 ELSE 0 END) AS mine FROM review_retries WHERE budget_key = ?")
      .bind(ctx.nodeId, budgetKey)
      .first<{ used: number; mine: number | null }>();
    nodeRetried = (used?.mine ?? 0) > 0;
    budgetLeft = Math.max(0, (await autoCap(env, options)) - (used?.used ?? 0));
  }
  const action = decideRetry(review, { mode, isRetry: !!options.reviewRetryOf, nodeRetried, retryCredits: ctx.credits, budgetLeft, hasNode: !!(ctx.projectId && ctx.nodeId) });
  const out: ResultReview = { ...review, action, ...(options.reviewRetryOf && { retryOf: { jobId: options.reviewRetryOf.jobId } }) };
  await env.DB.prepare("UPDATE jobs SET review = ? WHERE id = ?").bind(JSON.stringify(out), ctx.jobId).run();
  return out;
}

async function setAction(env: Env, jobId: string, action: ReviewAction): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET review = json_set(review, '$.action', json(?)) WHERE id = ? AND review IS NOT NULL").bind(JSON.stringify(action), jobId).run();
}

/**
 * The `review-retry` step (Auto mode): reserves the retry against the turn's
 * budget (once per node), writes the fix to the node, quotes and starts the
 * retry run as the user who started this one. Anything that does not fit
 * leaves the "Retry with fix" offer instead. Returns the retry run id.
 */
export async function startReviewRetry(env: Env, ctx: JobContext, review: ResultReview): Promise<string | null> {
  if (review.action?.kind !== "auto" || !review.fix || !ctx.projectId || !ctx.nodeId) return null;
  const options = await runOptions(env, ctx.runId);
  if (!options.auto) return null;
  const budgetKey = options.auto.turnId ?? ctx.runId;
  const cap = await autoCap(env, options);
  const prior = await env.DB.prepare("SELECT job_id, retry_run_id FROM review_retries WHERE budget_key = ? AND node_id = ?").bind(budgetKey, ctx.nodeId).first<{ job_id: string; retry_run_id: string | null }>();
  if (prior) return prior.job_id === ctx.jobId ? prior.retry_run_id : null;
  const offer = async (): Promise<null> => {
    await env.DB.prepare("DELETE FROM review_retries WHERE budget_key = ? AND node_id = ? AND job_id = ? AND retry_run_id IS NULL").bind(budgetKey, ctx.nodeId, ctx.jobId).run();
    await setAction(env, ctx.jobId, { kind: "offer", reason: "budget" });
    return null;
  };

  const { memberships, prefs } = await loadAccount(env, ctx.createdBy);
  let auth: ReturnType<typeof buildContext>;
  try {
    auth = buildContext(ctx.createdBy, null, null, memberships, prefs ?? DEFAULT_PREFS, ctx.workspaceId);
  } catch {
    return offer();
  }
  if (!auth.isMember) return offer();
  const membership = memberships.find((m) => m.workspaceId === ctx.workspaceId);
  const caller = { userId: ctx.createdBy, workspaceId: ctx.workspaceId, canEdit: true };
  const room = projectRoom(env, ctx.projectId);
  const graph = await room.getGraph(caller);
  if (isRoomError(graph)) return offer();
  const node = graph.state.nodes.find((n) => n.id === ctx.nodeId);
  if (!node) return offer();
  const params = fixParams(node.params, review.fix);
  const previous = Object.fromEntries(Object.keys(params).map((k) => [k, node.params[k] ?? null]));

  // Reserve first (atomic: once per node, within what is left of the budget).
  const reserved = await env.DB.prepare(
    `INSERT INTO review_retries (budget_key, node_id, job_id, run_id, credits, prev_params, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE (SELECT COALESCE(SUM(credits), 0) FROM review_retries WHERE budget_key = ?1) + ?5 <= ?8
     ON CONFLICT (budget_key, node_id) DO NOTHING`,
  )
    .bind(budgetKey, ctx.nodeId, ctx.jobId, ctx.runId, ctx.credits, JSON.stringify(previous), Date.now(), cap)
    .run();
  if (!reserved.meta.changes) return offer();

  const patched = await room.applyPatch(caller, { baseRevision: graph.state.revision, ops: [{ op: "updateNode", nodeId: ctx.nodeId, params }], origin: "agent" });
  if (isRoomError(patched)) return offer();
  try {
    const q = await quoteRun(env, auth, {
      projectId: ctx.projectId,
      scope: "node",
      nodeIds: [ctx.nodeId],
      caller,
      matureAllowed: membership ? matureAllowedIn(auth, membership) : false,
      retryOf: ctx.runId,
      surface: "agent",
    });
    const used = await env.DB.prepare("SELECT COALESCE(SUM(credits), 0) AS used FROM review_retries WHERE budget_key = ? AND NOT (node_id = ? AND job_id = ?)").bind(budgetKey, ctx.nodeId, ctx.jobId).first<{ used: number }>();
    if (!q.quoteId || q.total > cap - (used?.used ?? 0)) {
      await revertParams(env, ctx.projectId, ctx.nodeId, previous, caller);
      return offer();
    }
    const started = await startRun(env, auth, q.quoteId, {}, { reviewRetryOf: { jobId: ctx.jobId, budgetKey } });
    await env.DB.prepare("UPDATE review_retries SET retry_run_id = ?, credits = ? WHERE budget_key = ? AND node_id = ?").bind(started.runId, q.total, budgetKey, ctx.nodeId).run();
    await setAction(env, ctx.jobId, { kind: "auto", runId: started.runId });
    return started.runId;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "review: auto retry not started", jobId: ctx.jobId, error: err instanceof Error ? err.message : String(err) }));
    await revertParams(env, ctx.projectId, ctx.nodeId, previous, caller);
    return offer();
  }
}

async function revertParams(env: Env, projectId: string, nodeId: string, previous: Record<string, unknown>, caller: { userId: string; workspaceId: string; canEdit: boolean }): Promise<boolean> {
  const room = projectRoom(env, projectId);
  const graph = await room.getGraph(caller);
  if (isRoomError(graph)) return false;
  const params = Object.fromEntries(Object.entries(previous).map(([k, v]) => [k, v ?? undefined]));
  const r = await room.applyPatch(caller, { baseRevision: graph.state.revision, ops: [{ op: "updateNode", nodeId, params }], origin: "agent" });
  return !isRoomError(r);
}

/**
 * The `review-pick` step of an Auto retry: the better of the original and the
 * retry stays current (ties keep the retry). Picking the original also puts
 * back the params the fix changed, so its version is not "Input changed".
 */
export async function pickBetterVersion(env: Env, ctx: JobContext, review: ResultReview | null): Promise<"original" | "retry" | null> {
  const options = await runOptions(env, ctx.runId);
  const of = options.reviewRetryOf;
  if (!of || !ctx.projectId || !ctx.nodeId) return null;
  const orig = await env.DB.prepare("SELECT review FROM jobs WHERE id = ?").bind(of.jobId).first<{ review: string | null }>();
  const original = parseJson<ResultReview | null>(orig?.review, null);
  const pick = pickCurrent(original, review);
  if (pick === "retry") return pick;
  const caller = { userId: ctx.createdBy, workspaceId: ctx.workspaceId, canEdit: true };
  const room = projectRoom(env, ctx.projectId);
  const versions = await room.listVersions(caller, ctx.nodeId);
  if (isRoomError(versions)) return null;
  const target = versions.versions.find((v) => v.jobId === of.jobId);
  if (!target) return null;
  const row = await env.DB.prepare("SELECT prev_params FROM review_retries WHERE budget_key = ? AND node_id = ?").bind(of.budgetKey, ctx.nodeId).first<{ prev_params: string | null }>();
  const previous = parseJson<Record<string, unknown> | null>(row?.prev_params, null);
  if (previous) await revertParams(env, ctx.projectId, ctx.nodeId, previous, caller);
  await quietly("review.pick", () => room.setActiveVersion(caller, ctx.nodeId!, target.id));
  return pick;
}
