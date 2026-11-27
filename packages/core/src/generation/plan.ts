/**
 * Run planning (M4), generation layer. Graph runs build on the structural plan
 * of `core/project/plan.ts` (ProjectRoom.planRun: scope, order, digests,
 * bypass pass-through, run / reuse / blocked / bypassed / none) and add what a
 * generation needs: the model (Auto resolved here so the quote shows it, D-009),
 * capability checks, plan resolution caps (D-006), mature routing (D-005) and a
 * frozen GenSpec + PriceRequest per `run` item. Tool pages plan a PromptSpec.
 */
import type { Catalog } from '../models/catalog';
import { matureRunProblem, unmetCapability, type AutoRequest } from '../models/capabilities';
import type { CatalogModel, GenerationMode, ImageSource } from '../models/types';
import type { PriceRequest } from '../models/catalog';
import type { GraphNode, GraphState } from '../graph/types';
import { outputType } from '../graph/ports';
import { hash64, stableStringify } from '../project/digest';
import type { PlanItem as StructuralItem } from '../project/plan';
import { lowestPlanFor, planAllowsResolution, resolutionRank, type PlanId } from '../pricing/config';
import { autoCandidates, chainVideoCandidates, chooseModel, fitRequest, matureCandidates, platformMatureCandidates, type Classify, familyFallbacks } from './auto';
import { cleanPrompt, findModel, imageSizeFor, isAuto, modelRefOf, settingsOf, textOfNode, usesSize, type NodeSettings } from './spec';
import type { BlockCode, ChainStep, GenInput, GenSpec, InputSource, PlanContext, PlanItem, RunPlan } from './types';
import { explicitSignal } from '../safety/rules';
import { canonicalPrompt, shotOfParams, type ShotSpec } from '../prompting/shot';
import type { MatureAccess } from '../safety/types';

const GENERATIVE = new Set<string>(['image', 'video']);

/** Provenance of every image input, in input order (D-005): outputs of nodes and items are generated. */
export function imageOriginsOf(inputs: readonly GenInput[]): ImageSource[] {
  return inputs.filter((i) => i.media === 'image').map((i) => ('assetId' in i.from ? i.from.origin : 'node' in i.from || 'item' in i.from ? 'generated' : 'upload'));
}

export class PlanInputError extends Error {
  override readonly name = 'PlanInputError';
}

export type Blocked = { code: BlockCode; reason: string; lowestPlan?: PlanItem['lowestPlan'] };

/**
 * D-005 quote-time text classifier for a mature-allowed caller's text-only
 * video: true when the prompt is explicit although the deterministic rules
 * found nothing. Asked only when no text-to-video model takes mature runs, so
 * the item is planned as a chain before anything is held (a `prepare` re-plan
 * could not add the keyframe step). Errors count as false.
 */
export type ExplicitCheck = (prompt: string) => Promise<boolean>;

export interface BuildSpecInput {
  kind: 'image' | 'video';
  modelRef: string;
  prompt: string;
  /** The shot `prompt` was composed from, when the prompt is still that text (see `shotOfParams`). */
  shot?: ShotSpec;
  settings: NodeSettings;
  inputs: GenInput[];
  /** Provenance of every image input, in input order (D-005). */
  imageOrigins: ImageSource[];
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
  /**
   * D-005 mature text-to-video chain: this item's ref and the ref its keyframe
   * step gets. Without it a mature text-only video that no model takes is blocked.
   */
  chain?: ChainRefs;
  explicit?: ExplicitCheck | null;
  /**
   * D-005: an input is a mature asset (a mature public-library item, a mature output).
   * For a mature-allowed caller the item runs as mature (routed like an explicit prompt);
   * for anyone else it is blocked (`mature_not_allowed`).
   */
  matureInputs?: boolean;
}

export interface ChainRefs {
  ref: string;
  keyframeRef: string;
  /** Retry of the animation alone: the keyframe the earlier run made (asset id). */
  priorKeyframe?: string;
}

/** The keyframe step of a chain (planned and priced as its own item, held together with the animation). */
export interface KeyframeStep {
  spec: GenSpec;
  model: CatalogModel;
  priceRequest: PriceRequest;
}

export type BuiltSpec =
  | { ok: true; spec: GenSpec; model: CatalogModel; priceRequest: PriceRequest; autoVia?: PlanItem['autoVia']; keyframe?: KeyframeStep }
  | ({ ok: false; model?: CatalogModel } & Blocked);

/** Internal: a failure caused by mature routing (the chain may still fit). */
type Direct = BuiltSpec | ({ ok: false; model?: CatalogModel; matureBlocked: true } & Blocked);

function modeOf(kind: 'image' | 'video', settings: NodeSettings, inputs: GenInput[]): GenerationMode {
  if (kind === 'image') return inputs.some((i) => i.role === 'edit') ? 'edit' : 't2i';
  const refs = inputs.filter((i) => i.role === 'reference').length;
  if (refs > 0 || settings.refsMode) return 'refs';
  const frames = inputs.filter((i) => i.role === 'frame').length;
  return frames >= 2 ? 'first_last_frame' : frames === 1 ? 'i2v' : 't2v';
}

function autoRequestOf(spec: Pick<GenSpec, 'kind' | 'mode' | 'inputs' | 'mature' | 'prompt' | 'seconds' | 'resolution' | 'ratio' | 'audio' | 'n'>): AutoRequest & { prompt: string } {
  const count = (role: GenInput['role']) => spec.inputs.filter((i) => i.role === role).length;
  return {
    prompt: spec.prompt,
    kind: spec.kind,
    mode: spec.mode,
    ...(spec.seconds !== undefined && { seconds: spec.seconds }),
    ...(spec.resolution !== undefined && { resolution: spec.resolution }),
    ...(spec.ratio !== undefined && { ratio: spec.ratio }),
    ...(spec.audio !== undefined && { audio: spec.audio }),
    ...(spec.n !== undefined && { n: spec.n }),
    referenceImages: spec.inputs.filter((i) => i.role === 'reference' && i.media === 'image').length,
    referenceVideos: spec.inputs.filter((i) => i.role === 'reference' && i.media === 'video').length,
    referenceAudios: count('audio'),
    inputImages: count('edit'),
    ...(spec.mature && { mature: true }),
  };
}

/** PriceRequest for a spec as `model` takes it. */
export function priceRequestOf(spec: GenSpec, model: CatalogModel): PriceRequest {
  const fitted = fitRequest(model, autoRequestOf({ ...spec }));
  const images = spec.inputs.filter((i) => i.media === 'image').length;
  const videos = spec.inputs.filter((i) => i.media === 'video' && i.role === 'reference').length;
  const size = usesSize(model) ? imageSizeFor(spec.resolution, spec.ratio) : null;
  return {
    ...(size && { size }),
    ...(fitted.resolution !== undefined && { resolution: fitted.resolution }),
    ...(fitted.seconds !== undefined && { seconds: fitted.seconds }),
    ...(fitted.audio !== undefined && { audio: fitted.audio }),
    ...(fitted.n !== undefined && { n: fitted.n }),
    inputImages: images,
    referenceVideos: videos,
    ...(videos > 0 && spec.inputVideoMs !== undefined && { inputVideoMs: spec.inputVideoMs }),
  };
}

/** Why `model` cannot take this spec (capability, plan cap, mature routing), or null. */
export function modelProblem(model: CatalogModel, spec: GenSpec, ctx: PlanContext, imageOrigins: readonly ImageSource[]): Blocked | null {
  if (model.kind !== spec.kind) return { code: 'unsupported', reason: `${model.displayName} does not make ${spec.kind}s.` };
  const req = fitRequest(model, autoRequestOf({ ...spec }));
  const unmet = unmetCapability(model, { ...req, mature: false });
  if (unmet) return { code: 'unsupported', reason: `${model.displayName} does not support this ${unmet}.` };
  const resolution = usesSize(model) ? spec.resolution : (req.resolution ?? model.defaultResolution);
  if (usesSize(model) && spec.resolution !== undefined && imageSizeFor(spec.resolution, spec.ratio) === null) {
    return { code: 'unsupported', reason: `${model.displayName} does not support ${spec.resolution} at ${spec.ratio ?? '1:1'}.` };
  }
  if (ctx.plan && resolution && !planAllowsResolution(ctx.plan, spec.kind, resolution)) {
    return { code: 'resolution_locked', reason: `${resolution} needs a higher plan.`, lowestPlan: lowestPlanFor(spec.kind, resolution) };
  }
  if (spec.mature) {
    const problem = matureRunProblem(model, imageOrigins, imageOrigins.length);
    if (problem) {
      return model.matureRouting === 'platform_assets_only'
        ? { code: 'identity_requires_platform_assets', reason: 'Mature runs on this model take only pictures made on Rolling, Characters or the public library.' }
        : { code: 'mature_not_allowed', reason: `${model.displayName} does not take mature runs.` };
    }
  }
  return null;
}

/** D-005 access of the caller for a plan context (`allowed` iff `matureAllowed`). */
export function matureAccessOfPlan(ctx: PlanContext): MatureAccess {
  if (ctx.matureAllowed) return 'allowed';
  return ctx.matureAccess && ctx.matureAccess !== 'allowed' ? ctx.matureAccess : 'preference_off';
}

/** Identity-driven mature models only when the run has pictures, all platform assets (D-005). */
function withPictures(models: CatalogModel[], imageOrigins: readonly ImageSource[]): CatalogModel[] {
  if (imageOrigins.length === 0) return [];
  return models.filter((m) => matureRunProblem(m, imageOrigins, imageOrigins.length) === null);
}

/** Models that take this mature spec (routing, identity rule, capability, plan cap), cheapest first; `preferred` first when it qualifies. */
function matureCapable(catalog: Catalog, spec: GenSpec, ctx: PlanContext, imageOrigins: readonly ImageSource[], preferred?: CatalogModel): CatalogModel[] {
  const req = autoRequestOf(spec);
  const pool = [
    ...(preferred ? familyFallbacks(catalog, preferred, req, ctx.plan) : []),
    ...matureCandidates(catalog, req, ctx.plan),
    ...withPictures(platformMatureCandidates(catalog, req, ctx.plan), imageOrigins),
  ];
  const seen = new Set<string>();
  return pool.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return matureRunProblem(m, imageOrigins, imageOrigins.length) === null && modelProblem(m, spec, ctx, imageOrigins) === null;
  });
}

export const NO_MATURE_MODEL_REASON = 'No model that takes mature content fits these settings.';

/** Keyframe pictures are drawn at a 1K pixel budget (720p and below match it; the animation step scales). */
export const KEYFRAME_RESOLUTION = '1K';

/** Still-picture direction for the keyframe step, ahead of the user's prompt. */
export const KEYFRAME_DIRECTION = 'The opening frame of this video as one still picture, same subjects, setting, framing and lighting:';

export const NO_MATURE_KEYFRAME_REASON = 'No picture model that takes mature content is available to make the first frame.';

/** Ref of the keyframe step of a chain item. */
export function keyframeRefOf(ref: string): string {
  return ref === 'spec' ? 'keyframe' : `${ref}:keyframe`;
}

interface Prepared {
  prompt: string;
  matureAuto: boolean;
  base: Omit<GenSpec, 'modelId' | 'auto' | 'fallbacks'>;
}

/** A text-only video of a chain-capable item. */
function chainable(input: BuildSpecInput, base: Prepared['base']): boolean {
  return input.chain !== undefined && base.kind === 'video' && base.mode === 't2v' && base.inputs.length === 0;
}

/** Some listed text-to-video model takes a mature run of these settings directly (no chain needed). */
function directMatureVideo(input: BuildSpecInput, base: Prepared['base']): boolean {
  return matureCandidates(input.catalog, autoRequestOf({ ...base, mature: true }), input.ctx.plan).length > 0;
}

async function prepareSpec(input: BuildSpecInput): Promise<Prepared> {
  const { kind, inputs, ctx } = input;
  const prompt = cleanPrompt(input.prompt);
  // D-005: a mature-allowed caller's explicit prompt runs as a mature run without asking (Quick Create, Home, tools and
  // canvas nodes never send the toggle on their own). Callers without access keep the flag off: the quote asks them.
  let matureAuto = !input.settings.mature && ctx.matureAllowed && (input.matureInputs === true || explicitSignal(prompt).length > 0);
  const baseOf = (mature: boolean): Prepared['base'] => {
    const settings = mature ? { ...input.settings, mature: true } : input.settings;
    return {
      kind,
      mode: modeOf(kind, settings, inputs),
      prompt,
      ...(input.shot && { shot: input.shot }),
      ...(settings.negativePrompt !== undefined && { negativePrompt: settings.negativePrompt }),
      ...(settings.seed !== undefined && { seed: settings.seed }),
      ...(settings.seconds !== undefined && { seconds: settings.seconds }),
      ...(settings.resolution !== undefined && { resolution: settings.resolution }),
      ...(settings.ratio !== undefined && { ratio: settings.ratio }),
      ...(settings.audio !== undefined && { audio: settings.audio }),
      ...(settings.n !== undefined && { n: settings.n }),
      mature: settings.mature,
      matureAccess: matureAccessOfPlan(ctx),
      ...(matureAuto && { matureAuto: true as const }),
      inputs,
    };
  };
  let base = baseOf(matureAuto);
  // The rules see nothing, but the classifier may: for a text-only video that only a chain can make mature, ask now,
  // so the quote prices both steps (a re-plan in `prepare` would fail after the hold).
  if (!matureAuto && !input.settings.mature && ctx.matureAllowed && input.explicit && prompt !== '' && chainable(input, base) && !directMatureVideo(input, base)) {
    let explicit = false;
    try {
      explicit = await input.explicit(prompt);
    } catch {
      explicit = false;
    }
    if (explicit) {
      matureAuto = true;
      base = baseOf(true);
    }
  }
  return { prompt, matureAuto, base };
}

/** Builds and validates the spec for one item and resolves Auto (D-009); a mature text-only video no model takes becomes a chain (D-005). */
export async function buildSpec(input: BuildSpecInput): Promise<BuiltSpec> {
  if ((input.settings.mature || input.matureInputs) && !input.ctx.matureAllowed) {
    return { ok: false, code: 'mature_not_allowed', reason: 'Mature content is off for this workspace.' };
  }
  const prep = await prepareSpec(input);
  const direct = await buildDirect(input, prep);
  if (!direct.ok && 'matureBlocked' in direct && chainable(input, prep.base)) return planChain(input, prep);
  if (!direct.ok && 'matureBlocked' in direct) {
    const { matureBlocked: _drop, ...rest } = direct;
    return rest;
  }
  return direct;
}

async function buildDirect(input: BuildSpecInput, prep: Prepared): Promise<Direct> {
  const { ctx } = input;
  const { prompt, matureAuto, base } = prep;
  const mode = base.mode;
  if (prompt === '' && (mode === 't2v' || mode === 't2i')) return { ok: false, code: 'empty_prompt', reason: 'Add a prompt first.' };

  let model: CatalogModel;
  let fallbacks: string[] = [];
  let autoVia: PlanItem['autoVia'];
  if (isAuto(input.modelRef)) {
    const req = autoRequestOf(base);
    let candidates = autoCandidates(input.catalog, req, ctx.plan).filter(
      (m) => !base.mature || matureRunProblem(m, input.imageOrigins, input.imageOrigins.length) === null,
    );
    // No Auto-eligible model takes this mature run: any listed mature-capable one (D-005 routing); with pictures that are
    // all platform assets (e.g. a mature public-library item), the identity-driven mature models too.
    if (candidates.length === 0 && base.mature) {
      candidates = [...matureCandidates(input.catalog, req, ctx.plan), ...withPictures(platformMatureCandidates(input.catalog, req, ctx.plan), input.imageOrigins)];
    }
    const chosen = await chooseModel({ request: req, candidates, classify: candidates.length > 0 ? (input.classify ?? null) : null });
    if (!chosen) {
      const reason = matureAuto ? NO_MATURE_MODEL_REASON : 'No model available on your plan fits these settings.';
      return base.mature ? { ok: false, code: 'no_capable_model', reason, matureBlocked: true } : { ok: false, code: 'no_capable_model', reason };
    }
    model = chosen.model;
    fallbacks = chosen.fallbacks.map((m) => m.id);
    autoVia = chosen.via;
  } else {
    const found = findModel(input.catalog, input.modelRef);
    if (!found) return { ok: false, code: 'unknown_model', reason: `Model “${input.modelRef}” is not available.` };
    model = found;
    // Same-family siblings, tried only after the chosen model keeps failing (transient errors).
    fallbacks = familyFallbacks(input.catalog, model, autoRequestOf(base), ctx.plan)
      .filter((m) => !base.mature || matureRunProblem(m, input.imageOrigins, input.imageOrigins.length) === null)
      .map((m) => m.id);
  }
  let spec: GenSpec = { ...base, modelId: model.id, auto: isAuto(input.modelRef), fallbacks };
  if (matureAuto && matureRunProblem(model, input.imageOrigins, input.imageOrigins.length) !== null) {
    // The chosen model can't take the mature run this prompt needs: a mature-capable one of the same family, else the cheapest.
    const capable = matureCapable(input.catalog, spec, ctx, input.imageOrigins, model);
    if (capable.length === 0) return { ok: false, model, code: 'no_capable_model', reason: NO_MATURE_MODEL_REASON, matureBlocked: true };
    model = capable[0]!;
    spec = { ...spec, modelId: model.id, fallbacks: capable.slice(1, 4).map((m) => m.id) };
  }
  const problem = modelProblem(model, spec, ctx, input.imageOrigins);
  if (problem) {
    const routing = base.mature && (problem.code === 'mature_not_allowed' || problem.code === 'identity_requires_platform_assets' || (problem.code === 'unsupported' && base.mode === 't2v'));
    return routing ? { ok: false, model, ...problem, matureBlocked: true } : { ok: false, model, ...problem };
  }
  return { ok: true, spec, model, priceRequest: priceRequestOf(spec, model), ...(autoVia && { autoVia }) };
}

/** `seconds` as `model` takes it: the nearest allowed length (ties go shorter), else clamped to its range. */
function snapSeconds(model: CatalogModel, seconds: number | undefined): number | undefined {
  if (!model.seconds) return undefined;
  const want = seconds ?? model.defaultSeconds ?? model.seconds.min;
  const { min, max, allowed } = model.seconds;
  if (allowed && allowed.length > 0) return [...allowed].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
  return Math.min(max, Math.max(min, want));
}

/** `resolution` as `model` takes it within the plan cap: the requested one, else the highest below it, else the lowest allowed. */
function snapResolution(model: CatalogModel, resolution: string | undefined, plan: PlanId | null): string | undefined {
  if (model.resolutions.length === 0) return undefined;
  const allowed = model.resolutions.filter((r) => !plan || planAllowsResolution(plan, 'video', r));
  if (allowed.length === 0) return undefined;
  const want = resolution ?? model.defaultResolution ?? allowed[0]!;
  if (allowed.includes(want)) return want;
  const byRank = [...allowed].sort((a, b) => resolutionRank(a) - resolutionRank(b));
  return [...byRank].reverse().find((r) => resolutionRank(r) <= resolutionRank(want)) ?? byRank[0];
}

/**
 * D-005 mature text-to-video chain: (a) a keyframe from the cheapest
 * mature-capable text-to-image model at the video's ratio, (b) the cheapest
 * mature image-to-video model (spicy family; the keyframe is a platform
 * picture) with that keyframe as the first frame and the user's prompt,
 * length and resolution (snapped to what the model takes, within the plan
 * cap). Either step without a model → blocked at quote with a clear reason.
 */
function planChain(input: BuildSpecInput, prep: Prepared): BuiltSpec {
  const { ctx, catalog } = input;
  const chain = input.chain!;
  const { base } = prep;
  const common = {
    mature: true,
    matureAccess: base.matureAccess ?? matureAccessOfPlan(ctx),
    ...(base.matureAuto && { matureAuto: true as const }),
  };

  let keyframe: KeyframeStep | undefined;
  let frameFrom: InputSource;
  if (chain.priorKeyframe) frameFrom = { assetId: chain.priorKeyframe, origin: 'generated' };
  else {
    const ratio = base.ratio && base.ratio !== 'adaptive' ? base.ratio : '16:9';
    const kf: Omit<GenSpec, 'modelId' | 'auto' | 'fallbacks'> = {
      kind: 'image',
      mode: 't2i',
      // A shot is drawn as its own still (no motion, camera move or sound); typed text keeps the still direction.
      prompt: base.shot ? canonicalPrompt(base.shot, 'still') : `${KEYFRAME_DIRECTION} ${prep.prompt}`,
      ...(base.shot && { shot: base.shot }),
      ...(base.negativePrompt !== undefined && { negativePrompt: base.negativePrompt }),
      resolution: KEYFRAME_RESOLUTION,
      ratio,
      ...common,
      inputs: [],
      chain: { step: 'keyframe', with: chain.ref },
    };
    const pool = matureCandidates(catalog, autoRequestOf(kf), ctx.plan).filter((m) => modelProblem(m, { ...kf, modelId: m.id, auto: true, fallbacks: [] }, ctx, []) === null);
    const m = pool[0];
    if (!m) return { ok: false, code: 'no_capable_model', reason: NO_MATURE_KEYFRAME_REASON };
    const spec: GenSpec = { ...kf, modelId: m.id, auto: true, fallbacks: pool.slice(1, 4).map((x) => x.id) };
    keyframe = { spec, model: m, priceRequest: priceRequestOf(spec, m) };
    frameFrom = { item: chain.keyframeRef };
  }

  const origins: ImageSource[] = ['generated'];
  const { audio: _audio, ...rest } = base;
  const video: Omit<GenSpec, 'modelId' | 'auto' | 'fallbacks'> = {
    ...rest,
    mode: 'i2v',
    ...common,
    inputs: [{ role: 'frame', media: 'image', from: frameFrom }],
    chain: { step: 'animate', with: chain.keyframeRef } satisfies ChainStep,
  };
  const fits = (m: CatalogModel, s: typeof video) => matureRunProblem(m, origins, 1) === null && modelProblem(m, { ...s, modelId: m.id, auto: false, fallbacks: [] }, ctx, origins) === null;
  // The user's length and resolution when a model takes them, else the nearest each model takes.
  let pool = chainVideoCandidates(catalog, autoRequestOf(video), ctx.plan).filter((m) => fits(m, video));
  let spec: typeof video = video;
  if (pool.length === 0) {
    const snapped = chainVideoCandidates(catalog, { kind: 'video', mode: 'i2v' }, ctx.plan)
      .map((m) => {
        const seconds = snapSeconds(m, base.seconds);
        const resolution = snapResolution(m, base.resolution, ctx.plan);
        const s = { ...video, ...(seconds !== undefined ? { seconds } : {}), ...(resolution !== undefined ? { resolution } : {}) };
        if (seconds === undefined) delete s.seconds;
        if (resolution === undefined) delete s.resolution;
        return { m, s };
      })
      .filter(({ m, s }) => fits(m, s));
    if (snapped[0]) {
      spec = snapped[0].s;
      pool = snapped.filter((x) => x.s.seconds === spec.seconds && x.s.resolution === spec.resolution).map((x) => x.m);
    }
  }
  const model = pool[0];
  if (!model) return { ok: false, code: 'no_capable_model', reason: NO_MATURE_MODEL_REASON };
  const full: GenSpec = { ...spec, modelId: model.id, auto: isAuto(input.modelRef), fallbacks: pool.slice(1, 4).map((m) => m.id) };
  return { ok: true, spec: full, model, priceRequest: priceRequestOf(full, model), ...(keyframe && { keyframe }) };
}

export interface PlanGraphInput {
  graph: GraphState;
  /**
   * The structural plan from `core/project` `planRun` (ProjectRoom.planRun):
   * scope, topological order, run / reuse / blocked / bypassed / none,
   * pass-through inputs, input digests and dependencies. This layer adds
   * models, capabilities, plan caps, mature routing and Auto.
   */
  structural: readonly StructuralItem[];
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
  /** D-005 quote-time text classifier for mature-allowed callers' text-only videos (see `ExplicitCheck`). */
  explicit?: ExplicitCheck | null;
}

function assetOrigin(node: GraphNode): ImageSource {
  const s = node.params.source;
  return s === 'generated' || s === 'character' || s === 'public' || s === 'mine' || s === 'team' || s === 'builtin' ? s : 'upload';
}

const STRUCTURAL_BLOCK: Record<StructuralItem['reason'] & string, BlockCode> = {
  NO_PROMPT: 'empty_prompt',
  INPUT_NOT_READY: 'missing_input',
  BYPASS_TYPE_MISMATCH: 'bypassed_input',
  UPSTREAM_BLOCKED: 'upstream_blocked',
};

/** Plans a graph run (canvas Run, Run all, Run up to here, Run from here). */
export async function planRun(input: PlanGraphInput): Promise<RunPlan> {
  const { graph, catalog, ctx } = input;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const items = new Map<string, PlanItem>();

  for (const s of input.structural) {
    const node = byId.get(s.nodeId);
    const params = node?.params ?? s.params;
    const modelRef = modelRefOf(params);
    const known = GENERATIVE.has(s.kind) && !isAuto(modelRef) ? findModel(catalog, modelRef) : null;
    const base: PlanItem = {
      ref: s.nodeId,
      nodeId: s.nodeId,
      title: s.title,
      kind: s.kind,
      action: s.action,
      dependsOn: [],
      model: known?.id ?? null,
      modelName: GENERATIVE.has(s.kind) ? (known?.displayName ?? (isAuto(modelRef) ? 'Auto' : modelRef)) : null,
      ...(s.inputDigest && { digest: s.inputDigest }),
    };
    const block = (code: BlockCode, reason: string, extra: Partial<PlanItem> = {}) => items.set(s.nodeId, { ...base, ...extra, action: 'blocked', code, reason });

    if (s.action === 'none' || s.action === 'bypassed') {
      items.set(s.nodeId, { ...base, ...(s.message && { reason: s.message }) });
      continue;
    }
    if (s.action === 'blocked') {
      block(STRUCTURAL_BLOCK[s.reason ?? 'INPUT_NOT_READY'] ?? 'missing_input', s.message ?? 'Blocked');
      continue;
    }
    if (!node) {
      block('missing_input', 'Node not found.');
      continue;
    }
    if (!GENERATIVE.has(s.kind)) {
      // Audio nodes: voice generation is an open decision (no provider yet).
      if (s.action === 'run') block('unsupported', 'Voice generation is not available yet.');
      else items.set(s.nodeId, base);
      continue;
    }
    if (node.status === 'queued' || node.status === 'generating') {
      items.set(s.nodeId, { ...base, action: 'reuse', reason: 'Already running' });
      continue;
    }

    // Inputs: a dependency this layer blocked blocks this item too.
    const kind = s.kind as 'image' | 'video';
    const settings = settingsOf(kind, params);
    // A node planned from a structured shot carries its own row of the script: the script node's text (every row)
    // is not repeated in its prompt.
    const nodeShot = shotOfParams(kind, params);
    const promptParts: string[] = [];
    const inputs: GenInput[] = [];
    let blocked: Blocked | null = null;
    for (const inp of s.inputs) {
      const up = byId.get(inp.nodeId);
      if (!up) {
        blocked ??= { code: 'missing_input', reason: 'An input node is missing.' };
        continue;
      }
      const upItem = items.get(up.id);
      if (upItem?.action === 'blocked') {
        blocked ??= { code: 'upstream_blocked', reason: `Waiting on “${up.title}”, which can’t run.` };
        continue;
      }
      const type = outputType(up);
      if (up.kind === 'text' || up.kind === 'script' || type === 'text') {
        if (up.kind === 'script' && nodeShot) continue;
        const text = up.kind === 'asset' ? '' : textOfNode(up.params);
        if (text) promptParts.push(text);
        continue;
      }
      if (!type) continue;
      let from: GenInput['from'];
      if (up.kind === 'asset') {
        const assetId = typeof up.params.assetId === 'string' ? up.params.assetId : inp.assetId;
        if (!assetId) {
          blocked ??= { code: 'missing_input', reason: `“${up.title}” has no file.` };
          continue;
        }
        from = { assetId, origin: assetOrigin(up) };
      } else {
        from = { node: up.id };
      }
      const role: GenInput['role'] =
        type === 'audio' ? 'audio' : kind === 'image' ? 'edit' : settings.refsMode || inp.port !== 'frame' ? 'reference' : 'frame';
      // Labels bind references in a composed prompt ("Image 1 is …"); a typed prompt never uses them.
      inputs.push({ role, media: type, from, ...(nodeShot && type === 'image' && up.title.trim() && { label: up.title.trim().slice(0, 80) }) });
    }
    if (blocked) {
      block(blocked.code, blocked.reason);
      continue;
    }
    if (s.action === 'reuse') {
      items.set(s.nodeId, base);
      continue;
    }

    const ownPrompt = typeof params.prompt === 'string' ? params.prompt : '';
    const prompt = [...promptParts, ownPrompt].filter((p) => p.trim() !== '').join('\n\n');
    const built = await buildSpec({
      kind,
      modelRef,
      prompt,
      // Other text wired into the node (a text node) is the user's own: the prompt then goes out as assembled.
      ...(nodeShot && promptParts.length === 0 && { shot: nodeShot }),
      settings,
      inputs,
      imageOrigins: imageOriginsOf(inputs),
      catalog,
      ctx,
      classify: input.classify ?? null,
      ...(kind === 'video' && { chain: { ref: s.nodeId, keyframeRef: keyframeRefOf(s.nodeId) }, explicit: input.explicit ?? null }),
    });
    if (!built.ok) {
      block(built.code, built.reason, {
        ...(built.model && { model: built.model.id, modelName: built.model.displayName }),
        ...(built.lowestPlan !== undefined && { lowestPlan: built.lowestPlan }),
      });
      continue;
    }
    // D-005 chain: the keyframe step runs first as its own item (no node); the node's item animates it.
    const keyframeRef = keyframeRefOf(s.nodeId);
    if (built.keyframe) {
      items.set(keyframeRef, {
        ref: keyframeRef,
        nodeId: null,
        title: `${s.title} · First frame`,
        kind: 'image',
        action: 'run',
        dependsOn: [],
        model: built.keyframe.model.id,
        modelName: built.keyframe.model.displayName,
        spec: built.keyframe.spec,
        priceRequest: built.keyframe.priceRequest,
      });
    }
    items.set(s.nodeId, {
      ...base,
      action: 'run',
      model: built.model.id,
      modelName: built.model.displayName,
      ...(built.autoVia && { autoVia: built.autoVia }),
      dependsOn: [...s.dependsOn, ...(built.keyframe ? [keyframeRef] : [])],
      paramsHash: paramsHash(node),
      spec: built.spec,
      priceRequest: built.priceRequest,
    });
  }
  return { items: [...items.values()] };
}

/** Hash of a node's kind and params: an edit after the quote changes it. */
export function paramsHash(node: Pick<GraphNode, 'kind' | 'params'>): string {
  return hash64(stableStringify({ k: node.kind, p: node.params }));
}

export type MatureReplan = { ok: true; spec: GenSpec; model: CatalogModel } | { ok: false; code: 'no_capable_model'; reason: string };

export interface MatureReplanInput {
  spec: GenSpec;
  /** The model the job was about to use. */
  model: CatalogModel;
  catalog: Catalog;
  plan: PlanId | null;
  /** The model's price for the spec fits what was held for the job. */
  fits: (model: CatalogModel) => boolean;
}

/**
 * D-005 re-plan in `prepare`: the pre-check found explicit content on a
 * non-mature item of a mature-allowed caller. The item becomes a mature run
 * (`moderation: "low"`); a model that can't take it falls back to a
 * mature-capable one within the hold (Auto: its candidates, filtered). Null
 * model → fail (refunded) with a clear reason.
 */
export function replanMature(input: MatureReplanInput): MatureReplan {
  const ctx: PlanContext = { plan: input.plan, matureAllowed: true };
  const origins = imageOriginsOf(input.spec.inputs);
  const spec: GenSpec = { ...input.spec, mature: true, matureAuto: true, matureAccess: 'allowed' };
  const ok = (m: CatalogModel) => matureRunProblem(m, origins, origins.length) === null && modelProblem(m, spec, ctx, origins) === null && input.fits(m);
  const fromSpec = spec.fallbacks.map((id) => input.catalog.get(id)).filter((m): m is CatalogModel => !!m);
  const pool = [input.model, ...fromSpec, ...matureCapable(input.catalog, spec, ctx, origins, input.model)];
  const seen = new Set<string>();
  const capable = pool.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), ok(m))));
  if (capable.length === 0) return { ok: false, code: 'no_capable_model', reason: `${NO_MATURE_MODEL_REASON} No credits were charged.` };
  const model = capable[0]!;
  return { ok: true, model, spec: { ...spec, modelId: model.id, fallbacks: capable.slice(1, 4).map((m) => m.id) } };
}
