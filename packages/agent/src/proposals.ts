/**
 * Propose tools: validation before a proposal is stored (docs/harness.md
 * section 5). Schema, ids exist, ports/types/cycles (`core/project`
 * applyGraphOps over `core/graph` validateConnection), model capabilities,
 * plan caps (D-006), mature routing (D-005), no timeline overlaps
 * (`core/timeline`), estimate via `creditsFor`. Proposals never mutate.
 */
import type { CatalogModel } from '@rolling/core';
import type { GraphState, LocalOp } from '@rolling/core/graph';
import { applyGraphOps } from '@rolling/core/project';
import { applyOps as applyTimelineOps, clipEnd, edlDuration, findClip, type Clip, type Edl, type TimelineOp } from '@rolling/core/timeline';
import type { z } from 'zod/v4';
import { planAllowsResolution } from '@rolling/core/pricing/config';
import { MATURE_REQUIRED_MESSAGE, SAFETY_BLOCKED_MESSAGE, type SafetyGate } from '@rolling/core/safety';
import { bestAllowedResolution, creditsForSpec, specFromParams, specProblems, type GenSpec } from './capabilities';
import { layoutNewNodes } from './layout';
import type { AccountSnapshot, AssetItem, ModelsPort } from './ports';
import type { ToolContext } from './tools';
import {
  FIELD_SCHEMAS,
  issueText,
  ProposeFieldsInput,
  ProposeGraphPatchInput,
  ProposePlanInput,
  ProposeTimelinePatchInput,
} from './tools/schemas';
import type {
  Estimate,
  EstimateItem,
  FieldsBody,
  GraphPatchBody,
  PlanBody,
  PlanOptionOut,
  PlanShotOut,
  Proposal,
  ProposalKind,
  ProposalRisk,
  TimelineHighlight,
  TimelinePatchBody,
} from './types';

export interface ProposeContext extends ToolContext {
  newId: () => string;
  now: () => number;
  /** `@` references of this turn, resolved. */
  refs: readonly AssetItem[];
  /** The user's message of this turn (removing user nodes needs an explicit ask). */
  userText: string;
}

export type ProposeResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

const fail = (error: string): ProposeResult => ({ ok: false, error });

export function availableCredits(a: Pick<AccountSnapshot, 'balance'>): number {
  return a.balance.plan + a.balance.purchased - a.balance.held;
}

export function makeEstimate(items: EstimateItem[], account: AccountSnapshot): Estimate {
  const credits = items.reduce((s, i) => s + i.credits, 0);
  return {
    credits,
    items,
    applyIsFree: true,
    balanceAfter: availableCredits(account) - credits,
    needsConfirm: credits > account.confirmThreshold,
  };
}

function risksFor(estimate: Estimate, account: AccountSnapshot, extra: ProposalRisk[] = []): ProposalRisk[] {
  const risks: ProposalRisk[] = [...extra];
  const available = availableCredits(account);
  if (estimate.credits > available) risks.push({ code: 'over_balance', data: { credits: estimate.credits, available } });
  if (estimate.needsConfirm) risks.push({ code: 'needs_confirm', data: { credits: estimate.credits, threshold: account.confirmThreshold } });
  return risks;
}

function proposal(
  ctx: ProposeContext,
  kind: ProposalKind,
  baseRevision: number | null,
  summary: string,
  estimate: Estimate,
  body: Proposal['body'],
  risks: ProposalRisk[] = [],
): Proposal {
  return {
    id: ctx.newId(),
    kind,
    baseRevision,
    summary,
    estimate,
    risks: risksFor(estimate, ctx.account, risks),
    body,
    status: 'proposed',
    createdAt: ctx.now(),
  };
}

// ---------------------------------------------------------------- plan

/** Default keyframe model: the catalog's default image model that can edit when refs are given. */
export function keyframeModel(models: ModelsPort, needsEdit: boolean): CatalogModel | undefined {
  const images = models.models().filter((m) => m.kind === 'image' && !m.hidden && !m.matureOnly && !m.requiresIdentitySafety && m.placement !== 'tool');
  const fits = (m: CatalogModel) => m.operations.includes(needsEdit ? 'edit' : 't2i');
  return images.find((m) => m.default && fits(m)) ?? images.find(fits);
}

const DEFAULT_RATIO = '16:9';

/**
 * Builds the GraphOps for one plan option: a script node, `@` reference
 * assets, then per shot an image keyframe and a video node fed by it.
 */
export function planOps(option: PlanOptionOut, refs: readonly AssetItem[], keyframe: { model: string; mode: 't2i' | 'edit' }): LocalOp[] {
  const ops: LocalOp[] = [];
  ops.push({
    op: 'addNode',
    tempId: 'script',
    kind: 'script',
    title: option.title,
    params: {
      rows: option.shots.map((s) => ({
        n: String(s.n).padStart(2, '0'),
        title: s.title,
        visual: s.visual,
        ...(s.line ? { line: s.line } : {}),
        seconds: s.seconds,
      })),
      ratio: option.ratio,
    },
  });
  const imageRefs = refs.filter((r) => r.kind === 'image');
  imageRefs.forEach((r, i) => {
    ops.push({ op: 'addNode', tempId: `ref${i + 1}`, kind: 'asset', title: r.name, params: { assetId: r.id, media: 'image', source: r.source } });
  });
  option.shots.forEach((s) => {
    const k = `key${s.n}`;
    const v = `shot${s.n}`;
    ops.push({
      op: 'addNode',
      tempId: k,
      kind: 'image',
      title: `Keyframe ${s.n}: ${s.title}`.slice(0, 200),
      params: { prompt: `${s.visual} First frame of the shot.`, model: keyframe.model, mode: keyframe.mode, ratio: option.ratio, count: 1 },
    });
    ops.push({
      op: 'addNode',
      tempId: v,
      kind: 'video',
      title: `Shot ${s.n}: ${s.title}`.slice(0, 200),
      params: {
        prompt: s.visual,
        model: s.model,
        mode: s.mode,
        seconds: s.seconds,
        ...(s.resolution ? { resolution: s.resolution } : {}),
        ratio: option.ratio,
        ...(s.line ? { line: s.line } : {}),
      },
    });
    ops.push({ op: 'connect', from: { node: 'script', port: 'out' }, to: { node: k, port: 'prompt' } });
    imageRefs.slice(0, 8).forEach((_r, i) => ops.push({ op: 'connect', from: { node: `ref${i + 1}`, port: 'out' }, to: { node: k, port: 'refs' } }));
    if (s.mode === 'i2v') ops.push({ op: 'connect', from: { node: k, port: 'out' }, to: { node: v, port: 'frame' } });
  });
  return ops;
}

/**
 * Whole-second shot lengths that add up to `target` and fit every model's
 * range, using as close to `preferred` shots as possible. Null when none fit.
 */
export function suggestSplit(target: number, ranges: readonly { min: number; max: number; allowed?: number[] }[], preferred: number): number[] | null {
  if (!ranges.length || !Number.isFinite(target) || target <= 0) return null;
  const min = Math.max(...ranges.map((r) => r.min));
  const max = Math.min(...ranges.map((r) => r.max));
  const total = Math.round(target);
  if (min > max || ranges.some((r) => r.allowed)) return null;
  const candidates = Array.from({ length: 12 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
  for (const n of candidates) {
    if (n * min > total || n * max < total) continue;
    const base = Math.floor(total / n);
    return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
  }
  return null;
}

/** Cheapest general video model for a total length (lowest allowed resolution), for budget hints. */
export function cheapestVideo(models: ModelsPort, account: AccountSnapshot, seconds: number): { model: string; resolution: string | null; credits: number } | null {
  let best: { model: string; resolution: string | null; credits: number } | null = null;
  for (const m of models.models()) {
    if (m.kind !== 'video' || m.hidden || m.matureOnly || m.requiresIdentitySafety || m.placement === 'tool' || !m.seconds) continue;
    if (!m.operations.includes('t2v') && !m.operations.includes('i2v')) continue;
    const resolution = m.resolutions.find((r) => !account.plan || planAllowsResolution(account.plan, 'video', r)) ?? null;
    if (m.resolutions.length && !resolution) continue;
    const per5 = models.creditsFor(m, { seconds: Math.min(Math.max(5, m.seconds.min), m.seconds.max), ...(resolution ? { resolution } : {}) });
    if (per5 === null) continue;
    const credits = Math.ceil((per5 / Math.min(Math.max(5, m.seconds.min), m.seconds.max)) * seconds);
    if (!best || credits < best.credits) best = { model: m.id, resolution, credits };
  }
  return best;
}

async function proposePlan(args: z.infer<typeof ProposePlanInput>, ctx: ProposeContext): Promise<ProposeResult> {
  const { models } = ctx.ports;
  const refs = ctx.refs.filter((r) => r.kind === 'image');
  const kf = keyframeModel(models, refs.length > 0);
  if (!kf) return fail('no image model is available for keyframes');
  const keyframe = { model: kf.id, mode: (refs.length ? 'edit' : 't2i') as 't2i' | 'edit' };
  const problems: string[] = [];
  const options: PlanOptionOut[] = [];
  const unpriced: string[] = [];
  let base: GraphState = { revision: 0, nodes: [], edges: [], groups: [] };
  if (ctx.thread.surface === 'canvas' && ctx.thread.projectId) {
    const g = await ctx.ports.canvas.getGraph(ctx.thread.projectId);
    if (g) base = g.state;
  }

  args.options.forEach((opt, oi) => {
    const ratio = opt.ratio ?? DEFAULT_RATIO;
    const shots: PlanShotOut[] = [];
    const items: EstimateItem[] = [];
    opt.shots.forEach((shot, si) => {
      const where = `options[${oi}].shots[${si}]`;
      const model = models.get(shot.model);
      if (!model) {
        problems.push(`${where}: model "${shot.model}" is not in the catalog; call models.capabilities with kind video`);
        return;
      }
      const mode = model.operations.includes('i2v') ? 'i2v' : 't2v';
      const resolution = opt.resolution ?? bestAllowedResolution(model, ctx.account.plan, 'video') ?? null;
      const spec: GenSpec = { kind: 'video', model: model.id, mode, seconds: shot.seconds, ratio, ...(resolution ? { resolution } : {}) };
      const p = specProblems(spec, models, ctx.account);
      if (p.length) {
        problems.push(`${where}: ${p.join('; ')}`);
        return;
      }
      const n = si + 1;
      const credits = creditsForSpec(spec, models);
      if (credits === null) unpriced.push(`shot ${n}`);
      const kfSpec: GenSpec = { kind: 'image', model: kf.id, mode: keyframe.mode, count: 1, ...(refs.length ? { inputImages: Math.min(refs.length, 8) } : {}) };
      const kfCredits = creditsForSpec(kfSpec, models);
      if (kfCredits === null) unpriced.push(`keyframe ${n}`);
      if (kfCredits !== null) items.push({ ref: `key${n}`, model: kf.id, kind: 'image', credits: kfCredits });
      if (credits !== null) items.push({ ref: `shot${n}`, model: model.id, kind: 'video', seconds: shot.seconds, ...(resolution ? { resolution } : {}), credits });
      shots.push({
        n,
        title: shot.title,
        seconds: shot.seconds,
        visual: shot.visual,
        ...(shot.line ? { line: shot.line } : {}),
        model: model.id,
        mode,
        resolution,
        credits: (credits ?? 0) + (kfCredits ?? 0),
      });
    });
    if (shots.length !== opt.shots.length) return;
    const option: PlanOptionOut = {
      title: opt.title,
      ratio,
      resolution: opt.resolution ?? null,
      seconds: Math.round(shots.reduce((s, x) => s + x.seconds, 0) * 100) / 100,
      shots,
      estimate: makeEstimate(items, ctx.account),
      ops: [],
    };
    const ops = layoutNewNodes(base, planOps(option, refs, keyframe));
    const applied = applyGraphOps(base, ops, { actor: 'agent' });
    if (!applied.ok) {
      problems.push(`options[${oi}]: the nodes would not connect (${applied.refusal.message})`);
      return;
    }
    option.ops = ops;
    options.push(option);
  });

  for (const [oi, o] of options.entries()) {
    if (Math.abs(o.seconds - args.seconds) > args.seconds * 0.1 + 1e-9) {
      problems.push(`options[${oi}]: shots add up to ${o.seconds}s, but the target is ${args.seconds}s (within 10%); change shot lengths or the number of shots`);
    }
  }
  if (!problems.length && options.length) {
    const available = availableCredits(ctx.account);
    const cheapest = Math.min(...options.map((o) => o.estimate.credits));
    const floor = cheapestVideo(models, ctx.account, args.seconds);
    if (cheapest > available && floor && floor.credits <= available) {
      problems.push(
        `every option costs more than the available ${available} credits (cheapest ${cheapest}); make one option cheaper, e.g. ${floor.model} at ${floor.resolution ?? 'its default resolution'} is about ${floor.credits} credits for ${args.seconds}s`,
      );
    }
  }
  if (problems.length) {
    // Models are bad at this arithmetic: name a split that fits each failing option's models.
    const hints: string[] = [];
    args.options.forEach((opt, oi) => {
      if (!problems.some((p) => p.startsWith(`options[${oi}]`))) return;
      const split = suggestSplit(args.seconds, opt.shots.map((sh) => models.get(sh.model)?.seconds).filter((x): x is NonNullable<typeof x> => !!x), opt.shots.length);
      if (split) hints.push(`options[${oi}] could use ${split.length} shot${split.length > 1 ? 's' : ''} of ${split.join(' + ')} seconds`);
    });
    return fail(`invalid plan: ${problems.slice(0, 6).join(' | ')}${hints.length ? `. Suggestion: ${hints.join('; ')}` : ''}`);
  }
  const body: PlanBody = { kind: 'plan', seconds: args.seconds, options, refs: refs.map((r) => r.id) };
  const cheapest = options.reduce((a, b) => (b.estimate.credits < a.estimate.credits ? b : a));
  const summary = args.summary?.trim() || `${options.length} options, ${options.map((o) => o.title).join(' / ')}`;
  return {
    ok: true,
    proposal: proposal(ctx, 'plan', ctx.thread.surface === 'canvas' ? base.revision : null, summary, cheapest.estimate, body, unpriced.length ? [{ code: 'unpriced', data: { refs: unpriced } }] : []),
  };
}

// ---------------------------------------------------------------- graph patch

const REMOVE_ASK = /\b(delete|remove|drop|get rid of|clear)\b|删除|删掉|移除|削除|삭제/i;

/** Inputs wired into a node in a graph state. */
function inputCounts(state: GraphState, nodeId: string) {
  let frames = 0;
  let refs = 0;
  for (const e of state.edges) {
    if (e.to.node !== nodeId) continue;
    if (e.to.port === 'frame') frames++;
    if (e.to.port === 'refs') refs++;
  }
  return { frames, refs };
}

/** Checks and prices the generative nodes a patch adds or changes, in the patched state. */
function checkTouchedNodes(
  after: GraphState,
  nodeIds: Iterable<string>,
  models: ModelsPort,
  account: AccountSnapshot,
  label: (id: string) => string,
): { problems: string[]; items: EstimateItem[]; unpriced: string[] } {
  const problems: string[] = [];
  const items: EstimateItem[] = [];
  const unpriced: string[] = [];
  for (const id of nodeIds) {
    const node = after.nodes.find((n) => n.id === id);
    if (!node || (node.kind !== 'video' && node.kind !== 'image')) continue;
    const spec = specFromParams(node.kind, node.params, inputCounts(after, id));
    if (!spec) {
      problems.push(`${label(id)}: set params.model to a ${node.kind} model id`);
      continue;
    }
    const p = specProblems(spec, models, account);
    if (p.length) {
      problems.push(`${label(id)}: ${p.join('; ')}`);
      continue;
    }
    const credits = creditsForSpec(spec, models);
    if (credits === null) unpriced.push(label(id));
    else items.push({ ref: label(id), model: spec.model, kind: spec.kind, ...(spec.seconds ? { seconds: spec.seconds } : {}), ...(spec.resolution ? { resolution: spec.resolution } : {}), credits });
  }
  return { problems, items, unpriced };
}

async function proposeGraphPatch(args: z.infer<typeof ProposeGraphPatchInput>, ctx: ProposeContext): Promise<ProposeResult> {
  if (!ctx.thread.projectId) return fail('this thread has no project; propose a plan instead');
  if (args.projectId !== ctx.thread.projectId) return fail(`projectId must be ${ctx.thread.projectId}`);
  const graph = await ctx.ports.canvas.getGraph(args.projectId);
  if (!graph) return fail('project not found');
  const state = graph.state;
  if (args.baseRevision !== state.revision) {
    return fail(`baseRevision ${args.baseRevision} is stale: the canvas is at revision ${state.revision}. Call canvas.get and build the ops again`);
  }
  const ops = args.ops as LocalOp[];
  const removesUser: string[] = [];
  for (const [i, op] of ops.entries()) {
    if (op.op === 'addNode' && op.tempId.startsWith('node_')) return fail(`ops[${i}]: tempId must be a short temp id like t1, not a node id`);
    if (op.op === 'removeNode') {
      const node = state.nodes.find((n) => n.id === op.nodeId);
      if (node && node.createdBy !== 'agent') removesUser.push(node.id);
    }
  }
  if (removesUser.length && !REMOVE_ASK.test(ctx.userText)) {
    return fail(`ops remove nodes the user made (${removesUser.join(', ')}); only remove them when the user asks`);
  }
  const laidOut = layoutNewNodes(state, ops);
  const applied = applyGraphOps(state, laidOut, { actor: 'agent' });
  if (!applied.ok) {
    const r = applied.refusal;
    return fail(`ops[${r.opIndex ?? '?'}] refused (${r.code}): ${r.message}`);
  }
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const op of laidOut) {
    if (op.op === 'addNode') added.push(op.tempId);
    else if (op.op === 'updateNode' && Object.keys(op.params).length) updated.push(op.nodeId);
    else if (op.op === 'removeNode') removed.push(op.nodeId);
  }
  const reverse = new Map(Object.entries(applied.idMap).map(([temp, real]) => [real, temp]));
  const touchedIds = [...added.map((t) => applied.idMap[t] ?? t), ...updated];
  const checked = checkTouchedNodes(applied.state, touchedIds, ctx.ports.models, ctx.account, (id) => reverse.get(id) ?? id);
  if (checked.problems.length) return fail(`invalid node settings: ${checked.problems.slice(0, 6).join(' | ')}`);
  const body: GraphPatchBody = {
    kind: 'graphPatch',
    projectId: args.projectId,
    ops: laidOut,
    touched: { added, updated, removed, edges: laidOut.filter((o) => o.op === 'connect' || o.op === 'disconnect').length },
  };
  const extra: ProposalRisk[] = [];
  if (removesUser.length) extra.push({ code: 'removes_user_nodes', data: { nodeIds: removesUser } });
  if (checked.unpriced.length) extra.push({ code: 'unpriced', data: { refs: checked.unpriced } });
  return { ok: true, proposal: proposal(ctx, 'graphPatch', state.revision, args.summary, makeEstimate(checked.items, ctx.account), body, extra) };
}

/**
 * Re-checks a graph patch against a newer revision. The ops are kept exactly
 * (Apply must produce the patch the user saw); the proposal is rebased when
 * they still apply, stale otherwise.
 */
export function rebaseGraphPatch(body: GraphPatchBody, state: GraphState): { ok: true; revision: number } | { ok: false; reason: string } {
  const applied = applyGraphOps(state, body.ops, { actor: 'agent' });
  return applied.ok ? { ok: true, revision: state.revision } : { ok: false, reason: applied.refusal.message };
}

// ---------------------------------------------------------------- timeline patch

function highlightsFor(before: Edl, after: Edl, ops: readonly TimelineOp[]): TimelineHighlight[] {
  const out = new Map<string, TimelineHighlight['kind']>();
  for (const op of ops) if ('clipId' in op) out.set(op.clipId, op.op === 'remove' ? 'remove' : (out.get(op.clipId) ?? 'change'));
  for (const t of before.tracks) {
    for (const c of t.clips as Clip[]) {
      const now = findClip(after, c.id);
      if (!now) out.set(c.id, 'remove');
      else if (now.clip.start !== c.start || clipEnd(now.clip) !== clipEnd(c)) out.set(c.id, out.get(c.id) ?? 'change');
    }
  }
  return [...out].map(([clipId, kind]) => ({ clipId, kind }));
}

export function validateTimelineOps(edl: Edl, ops: readonly TimelineOp[]): { ok: true; edl: Edl } | { ok: false; error: string } {
  const res = applyTimelineOps(edl, ops);
  return res.ok ? res : { ok: false, error: res.error };
}

async function proposeTimelinePatch(args: z.infer<typeof ProposeTimelinePatchInput>, ctx: ProposeContext): Promise<ProposeResult> {
  if (ctx.thread.canvasId && args.canvasId !== ctx.thread.canvasId) return fail(`canvasId must be ${ctx.thread.canvasId}`);
  const t = await ctx.ports.timeline.get(args.canvasId);
  if (!t) return fail('no timeline for this canvas');
  if (args.baseRevision !== t.revision) {
    return fail(`baseRevision ${args.baseRevision} is stale: the timeline is at revision ${t.revision}. Call timeline.get and build the ops again`);
  }
  const ops = args.ops as TimelineOp[];
  const res = validateTimelineOps(t.edl, ops);
  if (!res.ok) return fail(`timeline ops refused: ${res.error}`);
  const body: TimelinePatchBody = {
    kind: 'timelinePatch',
    canvasId: args.canvasId,
    ops,
    highlights: highlightsFor(t.edl, res.edl, ops),
    durationBefore: Math.round(edlDuration(t.edl) * 1000) / 1000,
    durationAfter: Math.round(edlDuration(res.edl) * 1000) / 1000,
  };
  return { ok: true, proposal: proposal(ctx, 'timelinePatch', t.revision, args.summary, makeEstimate([], ctx.account), body) };
}

export function rebaseTimelinePatch(body: TimelinePatchBody, current: { revision: number; edl: Edl }): { ok: true; revision: number } | { ok: false; reason: string } {
  const res = validateTimelineOps(current.edl, body.ops);
  return res.ok ? { ok: true, revision: current.revision } : { ok: false, reason: res.error };
}

// ---------------------------------------------------------------- fields

async function proposeFields(args: z.infer<typeof ProposeFieldsInput>, ctx: ProposeContext): Promise<ProposeResult> {
  const schema = FIELD_SCHEMAS[args.tool];
  const parsed = schema.safeParse(args.fields);
  if (!parsed.success) return fail(`invalid ${args.tool} fields: ${issueText(parsed.error)}`);
  const fields = parsed.data as Record<string, unknown>;
  const items: EstimateItem[] = [];
  if (args.tool === 'quick' && typeof fields.model === 'string') {
    const kind = fields.kind as 'video' | 'image';
    const spec = specFromParams(kind, { ...fields, ...(kind === 'image' && fields.count ? { count: fields.count } : {}) });
    if (spec) {
      const p = specProblems(spec, ctx.ports.models, ctx.account);
      if (p.length) return fail(`invalid quick fields: ${p.join('; ')}`);
      const credits = creditsForSpec(spec, ctx.ports.models);
      if (credits !== null) items.push({ ref: 'quick', model: spec.model, kind, ...(spec.seconds ? { seconds: spec.seconds } : {}), credits });
    }
  }
  const body: FieldsBody = { kind: 'fields', tool: args.tool, fields };
  return { ok: true, proposal: proposal(ctx, 'fields', null, `Filled the ${args.tool} form`, makeEstimate(items, ctx.account), body) };
}

// ---------------------------------------------------------------- entry

const SCHEMAS = {
  'propose.plan': ProposePlanInput,
  'propose.graphPatch': ProposeGraphPatchInput,
  'propose.timelinePatch': ProposeTimelinePatchInput,
  'propose.fields': ProposeFieldsInput,
} as const;

export type ProposeToolName = keyof typeof SCHEMAS;

export function isProposeTool(name: string): name is ProposeToolName {
  return name in SCHEMAS;
}

/**
 * Some models send nested arrays or objects as JSON strings
 * (`"options": "[{...}]"`), mostly on retries. Decode those before checking.
 */
export function decodeJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try {
        return decodeJsonStrings(JSON.parse(t), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => decodeJsonStrings(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const decoded = decodeJsonStrings(v, depth + 1);
      // Seen with DeepSeek on retries: the rest of the object is inside the string,
      // e.g. "options": "[...], \"summary\": \"...\"}". Re-read it as the object's tail.
      if (typeof decoded === 'string' && /^\s*[[{]/.test(decoded)) {
        // Also seen: the provider's own parameter markup leaking in, `"seconds" string="false">6`.
        let t = decoded
          .trim()
          .replace(/"([A-Za-z_]\w*)"\s+string="false">([^,}\]"<]*)/g, '"$1": $2')
          .replace(/"([A-Za-z_]\w*)"\s+string="true">([^,}\]"<]*)/g, (_m, key: string, v: string) => `"${key}": ${JSON.stringify(v)}`);
        if (!t.endsWith('}')) t += '}';
        try {
          const tail = JSON.parse(`{${JSON.stringify(k)}:${t}`) as Record<string, unknown>;
          for (const [tk, tv] of Object.entries(tail)) if (!(tk in out) || tk === k) out[tk] = decodeJsonStrings(tv, depth + 1);
          continue;
        } catch {
          // Not repairable; leave it for the schema error.
        }
      }
      if (!(k in out)) out[k] = decoded;
    }
    return out;
  }
  return value;
}

/** Models sometimes put the target length on each option instead of the top level. */
function hoistPlanSeconds(args: unknown): void {
  if (!args || typeof args !== 'object') return;
  const a = args as { seconds?: unknown; options?: unknown };
  if (a.seconds !== undefined || !Array.isArray(a.options)) return;
  const first = a.options[0] as { seconds?: unknown } | undefined;
  if (typeof first?.seconds === 'number') a.seconds = first.seconds;
}

/** Validates a propose call and builds the proposal. Never throws for bad input. */
export async function runPropose(name: ProposeToolName, rawArgs: unknown, ctx: ProposeContext): Promise<ProposeResult> {
  const decoded = decodeJsonStrings(rawArgs ?? {});
  if (name === 'propose.plan') hoistPlanSeconds(decoded);
  const parsed = SCHEMAS[name].safeParse(decoded);
  if (!parsed.success) return fail(`invalid input: ${issueText(parsed.error)}`);
  let result: ProposeResult;
  try {
    switch (name) {
      case 'propose.plan':
        result = await proposePlan(parsed.data as z.infer<typeof ProposePlanInput>, ctx);
        break;
      case 'propose.graphPatch':
        result = await proposeGraphPatch(parsed.data as z.infer<typeof ProposeGraphPatchInput>, ctx);
        break;
      case 'propose.timelinePatch':
        result = await proposeTimelinePatch(parsed.data as z.infer<typeof ProposeTimelinePatchInput>, ctx);
        break;
      case 'propose.fields':
        result = await proposeFields(parsed.data as z.infer<typeof ProposeFieldsInput>, ctx);
        break;
    }
  } catch (err) {
    return fail(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!result.ok || !ctx.ports.safety) return result;
  const problem = await safetyProblem(result.proposal, ctx.ports.safety, ctx.account.matureAllowed);
  return problem ? fail(problem) : result;
}

const PROMPT_KEYS = new Set(['prompt', 'visual']);

/** Generation prompts in a proposal body: `prompt` / `visual` strings anywhere (plan shots, node params, tool fields). */
export function proposalPrompts(body: unknown): { prompts: string[]; negative: string[] } {
  const prompts = new Set<string>();
  const negative = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && x.trim()) {
        if (PROMPT_KEYS.has(k)) prompts.add(x.trim());
        else if (k === 'negativePrompt') negative.add(x.trim());
      } else walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return { prompts: [...prompts].slice(0, 40), negative: [...negative].slice(0, 10) };
}

/**
 * D-005 gate over a valid proposal. A hard-limit hit makes it invalid with a
 * neutral reason so the model rewrites it; explicit prompts on a non-mature
 * turn get the mature-content reason.
 */
async function safetyProblem(p: Proposal, gate: SafetyGate, mature: boolean): Promise<string | null> {
  const { prompts, negative } = proposalPrompts(p.body);
  if (prompts.length === 0) return null;
  let v;
  try {
    v = await gate.checkProposal({ mature, prompts: prompts.map((prompt, i) => ({ prompt, ...(i === 0 && negative.length && { negativePrompt: negative.join('; ') }) })) });
  } catch {
    if (!mature) return null;
    v = { verdict: 'block' as const, reasons: [{ code: 'SAFETY_UNAVAILABLE' as const, detail: 'gate error' }], checks: [] };
  }
  if (v.verdict !== 'block') return null;
  if (v.reasons.every((r) => r.code === 'MATURE_REQUIRED')) {
    return `content rules: ${MATURE_REQUIRED_MESSAGE} Rewrite the prompts without explicit content, or tell the user how to turn on mature content.`;
  }
  return `content rules: ${SAFETY_BLOCKED_MESSAGE} Rewrite the affected prompts so they stay within the content rules, or tell the user it can't be made. Do not describe the rules in detail.`;
}
