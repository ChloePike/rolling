/**
 * Run planning (M4): the canonical planner for graph runs and tool-page prompt
 * specs. Pure; the API loads the graph, active versions and catalog and calls it
 * (ProjectRoom may call it too — keep one implementation).
 *
 * For each node in scope, in dependency order:
 *   none      text, script, asset, audio and render nodes (nothing to generate);
 *   bypassed  `params.bypassed === true`; dependents take its pass-through input;
 *   blocked   missing input, upstream blocked, unknown/incapable model, plan cap
 *             (D-006), mature routing (D-005), empty prompt;
 *   reuse     an active version made with the node's current input digest and
 *             no upstream item runs (unless the node is a forced target);
 *   run       otherwise. Auto resolves to a concrete model here (D-009) so the
 *             quote shows it.
 */
import type { Catalog } from '../models/catalog';
import { matureRunProblem, unmetCapability, type AutoRequest } from '../models/capabilities';
import type { CatalogModel, GenerationMode, ImageSource } from '../models/types';
import type { PriceRequest } from '../models/catalog';
import type { GraphNode, GraphState, PortType } from '../graph/types';
import { outputType } from '../graph/ports';
import { computeInputDigests, hash64, stableStringify } from '../project/digest';
import { lowestPlanFor, planAllowsResolution } from '../pricing/config';
import { autoCandidates, chooseModel, fitRequest, type Classify } from './auto';
import { cleanPrompt, findModel, imageSizeFor, isAuto, modelRefOf, settingsOf, textOfNode, usesSize, type NodeSettings, type PromptSpec } from './spec';
import type { ActiveVersion, BlockCode, GenInput, GenSpec, PlanContext, PlanItem, RunPlan, RunScope } from './types';

const GENERATIVE = new Set(['image', 'video']);

export class PlanInputError extends Error {
  override readonly name = 'PlanInputError';
}

/** Node ids in topological order (stable: graph order among ready nodes). */
export function dependencyOrder(graph: Pick<GraphState, 'nodes' | 'edges'>): string[] {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of graph.edges) if (known.has(e.from.node) && known.has(e.to.node)) indeg.set(e.to.node, indeg.get(e.to.node)! + 1);
  const out: string[] = [];
  const left = [...ids];
  while (left.length) {
    let i = left.findIndex((id) => indeg.get(id) === 0);
    if (i === -1) i = 0; // Cycle guard: graphs are acyclic (validateConnection).
    const [id] = left.splice(i, 1);
    out.push(id!);
    for (const e of graph.edges) if (e.from.node === id && indeg.has(e.to.node)) indeg.set(e.to.node, Math.max(0, indeg.get(e.to.node)! - 1));
  }
  return out;
}

function walk(graph: Pick<GraphState, 'edges'>, start: string, dir: 'up' | 'down'): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      const next = dir === 'up' ? (e.to.node === id ? e.from.node : null) : e.from.node === id ? e.to.node : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Nodes in scope and the targets that run even when their version is valid. */
export function scopeNodes(graph: Pick<GraphState, 'nodes' | 'edges'>, scope: RunScope, nodeIds: readonly string[] = []): { inScope: Set<string>; forced: Set<string> } {
  const known = new Set(graph.nodes.map((n) => n.id));
  for (const id of nodeIds) if (!known.has(id)) throw new PlanInputError(`Unknown node ${id}.`);
  switch (scope) {
    case 'all':
      return { inScope: known, forced: new Set() };
    case 'node':
    case 'selection':
      if (nodeIds.length === 0) throw new PlanInputError('nodeIds is required for this scope.');
      if (scope === 'node' && nodeIds.length !== 1) throw new PlanInputError('scope node takes exactly one node id.');
      return { inScope: new Set(nodeIds), forced: new Set(nodeIds) };
    case 'upTo':
    case 'from': {
      if (nodeIds.length !== 1) throw new PlanInputError(`scope ${scope} takes exactly one node id.`);
      return { inScope: walk(graph, nodeIds[0]!, scope === 'upTo' ? 'up' : 'down'), forced: new Set(nodeIds) };
    }
  }
}

interface ResolvedInputs {
  promptParts: string[];
  inputs: GenInput[];
  dependsOn: string[];
}

type Blocked = { code: BlockCode; reason: string; lowestPlan?: PlanItem['lowestPlan'] };

export interface BuildSpecInput {
  kind: 'image' | 'video';
  modelRef: string;
  prompt: string;
  settings: NodeSettings;
  inputs: GenInput[];
  /** Provenance of every image input, in input order (D-005). */
  imageOrigins: ImageSource[];
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
}

export type BuiltSpec =
  | { ok: true; spec: GenSpec; model: CatalogModel; priceRequest: PriceRequest; autoVia?: PlanItem['autoVia'] }
  | ({ ok: false; model?: CatalogModel } & Blocked);

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
    referenceImages: count('reference'),
    referenceAudios: count('audio'),
    inputImages: count('edit'),
    ...(spec.mature && { mature: true }),
  };
}

/** PriceRequest for a spec as `model` takes it. */
export function priceRequestOf(spec: GenSpec, model: CatalogModel): PriceRequest {
  const fitted = fitRequest(model, autoRequestOf({ ...spec }));
  const images = spec.inputs.filter((i) => i.media === 'image').length;
  const size = usesSize(model) ? imageSizeFor(spec.resolution, spec.ratio) : null;
  return {
    ...(size && { size }),
    ...(fitted.resolution !== undefined && { resolution: fitted.resolution }),
    ...(fitted.seconds !== undefined && { seconds: fitted.seconds }),
    ...(fitted.audio !== undefined && { audio: fitted.audio }),
    ...(fitted.n !== undefined && { n: fitted.n }),
    inputImages: images,
    referenceVideos: 0,
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

/** Builds and validates the spec for one item and resolves Auto (D-009). */
export async function buildSpec(input: BuildSpecInput): Promise<BuiltSpec> {
  const { kind, settings, inputs, ctx } = input;
  const prompt = cleanPrompt(input.prompt);
  if (settings.mature && !ctx.matureAllowed) {
    return { ok: false, code: 'mature_not_allowed', reason: 'Mature content is off for this workspace.' };
  }
  const mode = modeOf(kind, settings, inputs);
  const base: Omit<GenSpec, 'modelId' | 'auto' | 'fallbacks'> = {
    kind,
    mode,
    prompt,
    ...(settings.negativePrompt !== undefined && { negativePrompt: settings.negativePrompt }),
    ...(settings.seed !== undefined && { seed: settings.seed }),
    ...(settings.seconds !== undefined && { seconds: settings.seconds }),
    ...(settings.resolution !== undefined && { resolution: settings.resolution }),
    ...(settings.ratio !== undefined && { ratio: settings.ratio }),
    ...(settings.audio !== undefined && { audio: settings.audio }),
    ...(settings.n !== undefined && { n: settings.n }),
    mature: settings.mature,
    inputs,
  };
  if (prompt === '' && (mode === 't2v' || mode === 't2i')) return { ok: false, code: 'empty_prompt', reason: 'Add a prompt first.' };

  let model: CatalogModel;
  let fallbacks: string[] = [];
  let autoVia: PlanItem['autoVia'];
  if (isAuto(input.modelRef)) {
    const req = autoRequestOf(base);
    const candidates = autoCandidates(input.catalog, req, ctx.plan).filter(
      (m) => !base.mature || matureRunProblem(m, input.imageOrigins, input.imageOrigins.length) === null,
    );
    const chosen = await chooseModel({ request: req, candidates, classify: input.classify ?? null });
    if (!chosen) return { ok: false, code: 'no_capable_model', reason: 'No model available on your plan fits these settings.' };
    model = chosen.model;
    fallbacks = chosen.fallbacks.map((m) => m.id);
    autoVia = chosen.via;
  } else {
    const found = findModel(input.catalog, input.modelRef);
    if (!found) return { ok: false, code: 'unknown_model', reason: `Model “${input.modelRef}” is not available.` };
    model = found;
  }
  const spec: GenSpec = { ...base, modelId: model.id, auto: isAuto(input.modelRef), fallbacks };
  const problem = modelProblem(model, spec, ctx, input.imageOrigins);
  if (problem) return { ok: false, model, ...problem };
  return { ok: true, spec, model, priceRequest: priceRequestOf(spec, model), ...(autoVia && { autoVia }) };
}

export interface PlanGraphInput {
  graph: GraphState;
  /** Active version per node id. */
  active: ReadonlyMap<string, ActiveVersion>;
  scope: RunScope;
  nodeIds?: readonly string[];
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
}

function assetOrigin(node: GraphNode): ImageSource {
  const s = node.params.source;
  return s === 'generated' || s === 'character' || s === 'public' || s === 'mine' || s === 'team' || s === 'builtin' ? s : 'upload';
}

/** Plans a graph run (canvas Run, Run all, Run up to here, Run from here). */
export async function planRun(input: PlanGraphInput): Promise<RunPlan> {
  const { graph, active, catalog, ctx } = input;
  const { inScope: scopeSet, forced } = scopeNodes(graph, input.scope, input.nodeIds);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const versionIds = new Map<string, string>();
  for (const [id, v] of active) versionIds.set(id, v.versionId);
  const digests = computeInputDigests(graph, versionIds);
  const incoming = new Map<string, { port: string; from: string; i: number }[]>();
  graph.edges.forEach((e, i) => {
    const list = incoming.get(e.to.node) ?? [];
    list.push({ port: e.to.port, from: e.from.node, i });
    incoming.set(e.to.node, list);
  });
  for (const list of incoming.values()) list.sort((a, b) => (a.port === b.port ? a.i - b.i : a.port < b.port ? -1 : 1));

  const items = new Map<string, PlanItem>();

  /** What node `id` hands downstream on a port of `type`. */
  const outputOf = (id: string, type: PortType, seen: Set<string> = new Set()): { sources: GenInput['from'][]; origins: ImageSource[]; deps: string[] } | Blocked => {
    const node = byId.get(id)!;
    const item = items.get(id);
    if (seen.has(id)) return { code: 'missing_input', reason: 'Inputs loop.' };
    seen.add(id);
    if (item?.action === 'bypassed' || (!item && node.params.bypassed === true)) {
      // Pass-through: the bypassed node's own inputs of the same type.
      const ups = (incoming.get(id) ?? []).filter((e) => outputType(byId.get(e.from)!) === type);
      if (ups.length === 0) return { code: 'bypassed_input', reason: `${node.title} is bypassed and has no ${type} input to pass on.` };
      const out = { sources: [] as GenInput['from'][], origins: [] as ImageSource[], deps: [] as string[] };
      for (const e of ups) {
        const r = outputOf(e.from, type, seen);
        if ('code' in r) return r;
        out.sources.push(...r.sources);
        out.origins.push(...r.origins);
        out.deps.push(...r.deps);
      }
      return out;
    }
    if (node.kind === 'text' || node.kind === 'script') {
      const text = textOfNode(node.params);
      return { sources: text ? [{ text }] : [], origins: [], deps: [] };
    }
    if (node.kind === 'asset') {
      const assetId = typeof node.params.assetId === 'string' ? node.params.assetId : null;
      if (!assetId) return { code: 'missing_input', reason: `${node.title} has no file.` };
      return { sources: [{ assetId, origin: assetOrigin(node) }], origins: type === 'image' ? [assetOrigin(node)] : [], deps: [] };
    }
    if (item?.action === 'blocked') return { code: 'upstream_blocked', reason: `${node.title} can’t run: ${item.reason ?? 'blocked'}` };
    if (item?.action === 'run') return { sources: [{ node: id }], origins: type === 'image' ? ['generated'] : [], deps: [id] };
    const version = active.get(id);
    if (version?.assetId) return { sources: [{ node: id }], origins: type === 'image' ? ['generated'] : [], deps: [] };
    return { code: 'missing_input', reason: `${node.title} has no output yet.` };
  };

  const resolveInputs = (node: GraphNode, settings: NodeSettings): ResolvedInputs | Blocked => {
    const out: ResolvedInputs = { promptParts: [], inputs: [], dependsOn: [] };
    for (const e of incoming.get(node.id) ?? []) {
      const source = byId.get(e.from);
      if (!source) continue;
      const type = outputType(source);
      if (!type) continue;
      const r = outputOf(e.from, type);
      if ('code' in r) return r;
      out.dependsOn.push(...r.deps);
      for (const from of r.sources) {
        if ('text' in from) {
          out.promptParts.push(from.text);
          continue;
        }
        if (type === 'text') continue;
        const role: GenInput['role'] =
          type === 'audio' ? 'audio' : node.kind === 'image' ? 'edit' : settings.refsMode ? 'reference' : e.port === 'frame' ? 'frame' : 'reference';
        out.inputs.push({ role, media: type, from });
      }
    }
    out.dependsOn = [...new Set(out.dependsOn)];
    return out;
  };

  const originsOf = (inputs: GenInput[]): ImageSource[] =>
    inputs.filter((i) => i.media === 'image').map((i) => ('node' in i.from ? 'generated' : 'assetId' in i.from ? i.from.origin : 'upload'));

  for (const id of dependencyOrder(graph)) {
    const node = byId.get(id)!;
    if (!scopeSet.has(id)) continue;
    const base = {
      ref: id,
      nodeId: id,
      title: node.title,
      kind: node.kind,
      dependsOn: [] as string[],
      model: null as string | null,
      modelName: null as string | null,
      ...(digests.get(id) && { digest: digests.get(id)! }),
    };
    if (node.params.bypassed === true) {
      items.set(id, { ...base, action: 'bypassed', reason: 'Bypassed' });
      continue;
    }
    if (!GENERATIVE.has(node.kind)) {
      items.set(id, { ...base, action: 'none' });
      continue;
    }
    const kind = node.kind as 'image' | 'video';
    const modelRef = modelRefOf(node.params);
    const known = isAuto(modelRef) ? null : findModel(catalog, modelRef);
    const named = { model: known?.id ?? null, modelName: known?.displayName ?? (isAuto(modelRef) ? 'Auto' : modelRef) };
    if (node.status === 'queued' || node.status === 'generating') {
      items.set(id, { ...base, ...named, action: 'reuse', reason: 'Already running' });
      continue;
    }
    const settings = settingsOf(kind, node.params);
    const resolved = resolveInputs(node, settings);
    if ('code' in resolved) {
      items.set(id, { ...base, ...named, action: 'blocked', code: resolved.code, reason: resolved.reason });
      continue;
    }
    const version = active.get(id);
    const upstreamRuns = resolved.dependsOn.length > 0;
    if (!forced.has(id) && !upstreamRuns && version && version.digest === digests.get(id)) {
      items.set(id, { ...base, ...named, action: 'reuse' });
      continue;
    }
    const ownPrompt = typeof node.params.prompt === 'string' ? node.params.prompt : '';
    const prompt = [...resolved.promptParts, ownPrompt].filter((p) => p.trim() !== '').join('\n\n');
    const built = await buildSpec({
      kind,
      modelRef,
      prompt,
      settings,
      inputs: resolved.inputs,
      imageOrigins: originsOf(resolved.inputs),
      catalog,
      ctx,
      classify: input.classify ?? null,
    });
    if (!built.ok) {
      items.set(id, {
        ...base,
        ...named,
        ...(built.model && { model: built.model.id, modelName: built.model.displayName }),
        action: 'blocked',
        code: built.code,
        reason: built.reason,
        ...(built.lowestPlan !== undefined && { lowestPlan: built.lowestPlan }),
      });
      continue;
    }
    items.set(id, {
      ...base,
      action: 'run',
      model: built.model.id,
      modelName: built.model.displayName,
      ...(built.autoVia && { autoVia: built.autoVia }),
      dependsOn: resolved.dependsOn,
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

export interface PlanSpecInput {
  spec: PromptSpec;
  catalog: Catalog;
  ctx: PlanContext;
  classify?: Classify | null;
  /** Source of every input asset (D-005 provenance). Unknown assets block the item. */
  assetOrigins: ReadonlyMap<string, { origin: ImageSource; media: 'image' | 'video' | 'audio' }>;
}

/** Plans a tool page run: one item, ref `spec`, no graph. */
export async function planPromptSpec(input: PlanSpecInput): Promise<RunPlan> {
  const { spec } = input;
  const base = { ref: 'spec', nodeId: null, title: spec.title ?? (spec.kind === 'video' ? 'Video' : 'Image'), kind: spec.kind, dependsOn: [], model: null, modelName: null };
  const inputs: GenInput[] = [];
  const add = (assetId: string | undefined, role: GenInput['role']): Blocked | null => {
    if (!assetId) return null;
    const a = input.assetOrigins.get(assetId);
    if (!a) return { code: 'missing_input', reason: 'An input file is not available.' };
    inputs.push({ role, media: a.media, from: { assetId, origin: a.origin } });
    return null;
  };
  const i = spec.inputs;
  const problems = [
    add(i.firstFrameAssetId, spec.refsMode ? 'reference' : 'frame'),
    add(i.lastFrameAssetId, spec.refsMode ? 'reference' : 'frame'),
    ...(i.referenceAssetIds ?? []).map((a) => add(a, 'reference')),
    ...(i.inputAssetIds ?? []).map((a) => add(a, spec.kind === 'image' ? 'edit' : 'reference')),
    add(i.audioAssetId, 'audio'),
  ].filter((p): p is Blocked => p !== null);
  if (problems[0]) return { items: [{ ...base, action: 'blocked', ...problems[0] }] };
  const settings: NodeSettings = {
    ...(spec.seconds !== undefined && { seconds: spec.seconds }),
    ...(spec.resolution !== undefined && { resolution: spec.resolution }),
    ...(spec.ratio !== undefined && { ratio: spec.ratio }),
    ...(spec.audio !== undefined && { audio: spec.audio }),
    ...(spec.n !== undefined && spec.n > 1 && { n: spec.n }),
    ...(spec.negativePrompt !== undefined && { negativePrompt: spec.negativePrompt }),
    ...(spec.seed !== undefined && { seed: spec.seed }),
    mature: spec.mature === true,
    refsMode: spec.refsMode === true,
  };
  const built = await buildSpec({
    kind: spec.kind,
    modelRef: spec.model,
    prompt: spec.prompt,
    settings,
    inputs,
    imageOrigins: inputs.filter((x) => x.media === 'image').map((x) => ('assetId' in x.from ? x.from.origin : 'generated')),
    catalog: input.catalog,
    ctx: input.ctx,
    classify: input.classify ?? null,
  });
  if (!built.ok) {
    return {
      items: [
        {
          ...base,
          ...(built.model && { model: built.model.id, modelName: built.model.displayName }),
          action: 'blocked',
          code: built.code,
          reason: built.reason,
          ...(built.lowestPlan !== undefined && { lowestPlan: built.lowestPlan }),
        },
      ],
    };
  }
  return {
    items: [
      {
        ...base,
        action: 'run',
        model: built.model.id,
        modelName: built.model.displayName,
        ...(built.autoVia && { autoVia: built.autoVia }),
        spec: built.spec,
        priceRequest: built.priceRequest,
      },
    ],
  };
}
