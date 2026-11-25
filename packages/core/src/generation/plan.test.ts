import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import type { GraphEdge, GraphNode, GraphState } from '../graph/types';
import { computeInputDigests } from '../project/digest';
import { creditsFor } from '../pricing/config';
import { buildGenerateRequest } from './request';
import { planRun as planLayer } from './plan';
import { planPromptSpec } from './specPlan';
import { planRun as structuralPlan } from '../project/plan';
import type { Classify } from './auto';
import type { RunScope } from './types';
import { imageSizeFor } from './spec';
import type { ActiveVersion, PlanContext, PlanItem } from './types';

const PLUS: PlanContext = { plan: 'plus', matureAllowed: false };

function node(id: string, kind: GraphNode['kind'], params: Record<string, unknown> = {}, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind, title: id, params, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy: 'user', ...extra };
}

function edge(from: string, to: string, port: string): GraphEdge {
  return { id: `e_${from}_${to}_${port}`, from: { node: from, port: 'out' }, to: { node: to, port } };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): GraphState {
  return { revision: 1, nodes, edges, groups: [] };
}

/** Active versions where `valid` nodes carry the current digest and the rest a stale one. */
function versions(graph: GraphState, valid: string[], stale: string[] = []): Map<string, ActiveVersion> {
  const ids = new Map<string, string>();
  for (const id of [...valid, ...stale]) ids.set(id, `ver_${id}`);
  const digests = computeInputDigests(graph, ids);
  const out = new Map<string, ActiveVersion>();
  for (const id of valid) out.set(id, { versionId: `ver_${id}`, digest: digests.get(id)!, assetId: `ast_${id}` });
  for (const id of stale) out.set(id, { versionId: `ver_${id}`, digest: 'dg_old', assetId: `ast_${id}` });
  return out;
}

/** Structural plan (core/project, as ProjectRoom.planRun) + the generation layer. */
async function planRun(input: { graph: GraphState; active: Map<string, ActiveVersion>; scope: RunScope; nodeIds?: string[]; catalog: typeof fixtureCatalog; ctx: PlanContext; classify?: Classify }) {
  const ids = new Map([...input.active].map(([k, v]) => [k, v.versionId]));
  const digests = computeInputDigests(input.graph, ids);
  const structural = structuralPlan(input.graph, input.active, digests, input.scope, input.nodeIds ?? []);
  return planLayer({ graph: input.graph, structural, catalog: input.catalog, ctx: input.ctx, ...(input.classify && { classify: input.classify }) });
}

const byRef = (items: PlanItem[]) => Object.fromEntries(items.map((i) => [i.ref, i]));

/** The sample canvas: script → keyframe → shot A; photo → keyframe; keyframe → shot B; missing asset → shot C. */
function sample() {
  const nodes = [
    node('script', 'script', { text: 'A sparkling water ad. Morning by a river.' }),
    node('photo', 'asset', { assetId: 'ast_photo', source: 'mine', media: 'image' }),
    node('keyframe', 'image', { model: 'Seedream 5.0 Lite', prompt: 'Bottle on a @[Rock]', ratio: '9:16', resolution: '2K' }),
    node('shotA', 'video', { model: 'Seedance 2.0 Mini', prompt: 'Slow push-in', ratio: '9:16', resolution: '720p', length: 5, extra: '×1 · Audio on' }),
    node('shotB', 'video', { model: 'bytedance/seedance-2.0-mini', prompt: 'Cap pop', resolution: '480p', length: 5 }),
    node('empty', 'asset', { media: 'image' }),
    node('shotC', 'video', { model: 'Seedance 2.0 Mini', prompt: 'Pour', resolution: '480p', length: 5 }),
  ];
  const edges = [
    edge('script', 'keyframe', 'prompt'),
    edge('photo', 'keyframe', 'refs'),
    edge('keyframe', 'shotA', 'frame'),
    edge('keyframe', 'shotB', 'frame'),
    edge('empty', 'shotC', 'frame'),
  ];
  return graphOf(nodes, edges);
}

describe('planRun', () => {
  it('run all: reuses valid versions, runs stale ones, blocks a node with a missing input', async () => {
    const g = sample();
    const plan = await planRun({ graph: g, active: versions(g, ['keyframe'], ['shotA']), scope: 'all', catalog: fixtureCatalog, ctx: PLUS });
    const items = byRef(plan.items);
    expect(items.script).toMatchObject({ action: 'none' });
    expect(items.photo).toMatchObject({ action: 'none' });
    expect(items.keyframe).toMatchObject({ action: 'reuse', model: 'bytedance/seedream-5.0-lite', modelName: 'Seedream 5.0 Lite' });
    expect(items.shotA).toMatchObject({ action: 'run', model: 'bytedance/seedance-2.0-mini', dependsOn: [] });
    expect(items.shotA!.spec).toMatchObject({ mode: 'i2v', seconds: 5, resolution: '720p', ratio: '9:16', audio: true });
    expect(items.shotA!.spec!.inputs).toEqual([{ role: 'frame', media: 'image', from: { node: 'keyframe' } }]);
    expect(items.shotB).toMatchObject({ action: 'run' });
    expect(items.shotC).toMatchObject({ action: 'blocked', code: 'missing_input', reason: '“empty” has no file.' });
    // Credits come from the catalog price of the frozen request.
    const credits = creditsFor(fixtureCatalog.get('bytedance/seedance-2.0-mini')!, items.shotA!.priceRequest);
    expect(credits).toBeGreaterThan(0);
  });

  it('runs dependents after an upstream item that runs, and builds the prompt from text inputs', async () => {
    const g = sample();
    const plan = await planRun({ graph: g, active: versions(g, [], []), scope: 'upTo', nodeIds: ['shotA'], catalog: fixtureCatalog, ctx: PLUS });
    const items = byRef(plan.items);
    expect(Object.keys(items).sort()).toEqual(['keyframe', 'photo', 'script', 'shotA']);
    expect(items.keyframe).toMatchObject({ action: 'run', dependsOn: [] });
    expect(items.keyframe!.spec).toMatchObject({ mode: 'edit', prompt: 'A sparkling water ad. Morning by a river. Bottle on a Rock' });
    expect(items.keyframe!.spec!.inputs).toEqual([{ role: 'edit', media: 'image', from: { assetId: 'ast_photo', origin: 'mine' } }]);
    expect(items.keyframe!.priceRequest).toMatchObject({ size: '1536x2752', inputImages: 1 });
    expect(items.shotA).toMatchObject({ action: 'run', dependsOn: ['keyframe'] });
  });

  it('forces the target of a node run even when its version is valid', async () => {
    const g = sample();
    const plan = await planRun({ graph: g, active: versions(g, ['keyframe', 'shotA']), scope: 'node', nodeIds: ['shotA'], catalog: fixtureCatalog, ctx: PLUS });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ ref: 'shotA', action: 'run', dependsOn: [] });
  });

  it('blocks a missing upstream output outside the scope and cascades blocks downstream', async () => {
    const g = sample();
    const single = await planRun({ graph: g, active: new Map(), scope: 'node', nodeIds: ['shotA'], catalog: fixtureCatalog, ctx: PLUS });
    expect(single.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input', reason: '“keyframe” has no output yet.' });

    g.nodes.find((n) => n.id === 'keyframe')!.params.model = 'Nope 9';
    const all = byRef((await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: PLUS })).items);
    expect(all.keyframe).toMatchObject({ action: 'blocked', code: 'unknown_model' });
    expect(all.shotA).toMatchObject({ action: 'blocked', code: 'upstream_blocked' });
  });

  it('refuses resolutions above the plan cap with the lowest plan that allows them (D-006)', async () => {
    const g = sample();
    g.nodes.find((n) => n.id === 'shotB')!.params.model = 'Seedance 2.5';
    g.nodes.find((n) => n.id === 'shotB')!.params.resolution = '1080p';
    const plan = await planRun({ graph: g, active: versions(g, ['keyframe']), scope: 'node', nodeIds: ['shotB'], catalog: fixtureCatalog, ctx: { plan: 'starter', matureAllowed: false } });
    expect(plan.items[0]).toMatchObject({ action: 'blocked', code: 'resolution_locked', lowestPlan: 'plus', model: 'bytedance/seedance-2.5' });
  });

  it('refuses settings the model cannot do', async () => {
    const g = sample();
    g.nodes.find((n) => n.id === 'shotB')!.params.length = 60;
    const plan = await planRun({ graph: g, active: versions(g, ['keyframe']), scope: 'node', nodeIds: ['shotB'], catalog: fixtureCatalog, ctx: PLUS });
    expect(plan.items[0]).toMatchObject({ action: 'blocked', code: 'unsupported' });
  });

  it('passes a bypassed node’s input through, or blocks dependents when there is none', async () => {
    const nodes = [
      node('photo', 'asset', { assetId: 'ast_p', source: 'generated', media: 'image' }),
      { ...node('img', 'image', { model: 'Seedream 5.0 Lite', prompt: 'x' }), bypass: true } as GraphNode,
      node('vid', 'video', { model: 'Seedance 2.0 Mini', prompt: 'move', length: 5 }),
      { ...node('img2', 'image', { model: 'Seedream 5.0 Lite', prompt: 'y' }), bypass: true } as GraphNode,
      node('vid2', 'video', { model: 'Seedance 2.0 Mini', prompt: 'move', length: 5 }),
    ];
    const g = graphOf(nodes, [edge('photo', 'img', 'refs'), edge('img', 'vid', 'frame'), edge('img2', 'vid2', 'frame')]);
    const items = byRef((await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: PLUS })).items);
    expect(items.img).toMatchObject({ action: 'bypassed' });
    expect(items.vid).toMatchObject({ action: 'run' });
    expect(items.vid!.spec!.inputs).toEqual([{ role: 'frame', media: 'image', from: { assetId: 'ast_p', origin: 'generated' } }]);
    expect(items.vid2).toMatchObject({ action: 'blocked', code: 'bypassed_input' });
  });

  it('applies mature routing (D-005)', async () => {
    const g = graphOf([node('img', 'image', { model: 'Seedream 5.0 Lite', prompt: 'x', mature: true })], []);
    const off = await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: PLUS });
    expect(off.items[0]).toMatchObject({ action: 'blocked', code: 'mature_not_allowed' });
    const on = { plan: 'plus' as const, matureAllowed: true };
    const wrongModel = await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: on });
    expect(wrongModel.items[0]).toMatchObject({ action: 'blocked', code: 'mature_not_allowed', model: 'bytedance/seedream-5.0-lite' });
    g.nodes[0]!.params.model = 'auto';
    const auto = await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: on });
    expect(auto.items[0]).toMatchObject({ action: 'run' });
    expect(fixtureCatalog.get(auto.items[0]!.model!)!.matureRouting).toBe('allowed');
    expect(auto.items[0]!.spec!.mature).toBe(true);
  });

  it('lets identity-driven models take mature runs only with platform assets', async () => {
    const photo = (source: string) => node('photo', 'asset', { assetId: 'ast_p', source, media: 'image' });
    const vid = node('vid', 'video', { model: 'lumina/wan2.2-i2v-spicy', prompt: 'move', mature: true, resolution: '480p', length: 5 });
    const on = { plan: 'pro' as const, matureAllowed: true };
    const uploaded = graphOf([photo('mine'), vid], [edge('photo', 'vid', 'frame')]);
    const a = await planRun({ graph: uploaded, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: on });
    expect(byRef(a.items).vid).toMatchObject({ action: 'blocked', code: 'identity_requires_platform_assets' });
    const platform = graphOf([photo('character'), { ...vid }], [edge('photo', 'vid', 'frame')]);
    const b = await planRun({ graph: platform, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: on });
    expect(byRef(b.items).vid).toMatchObject({ action: 'run', model: 'lumina/wan2.2-i2v-spicy' });
  });

  it('resolves Auto before the quote (D-009) and lists fallbacks', async () => {
    const g = graphOf([node('v', 'video', { model: 'Auto', prompt: 'A cat', resolution: '480p', length: 5 })], []);
    const plan = await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: PLUS, classify: async () => ({ modelId: 'bytedance/seedance-2.5' }) });
    expect(plan.items[0]).toMatchObject({ action: 'run', model: 'bytedance/seedance-2.5', autoVia: 'classifier' });
    expect(plan.items[0]!.spec!.auto).toBe(true);
    expect(plan.items[0]!.spec!.fallbacks.length).toBeGreaterThan(0);
    expect(plan.items[0]!.spec!.fallbacks).not.toContain('bytedance/seedance-2.5');
  });

  it('marks nodes that are already running as reuse', async () => {
    const g = graphOf([node('v', 'video', { model: 'Seedance 2.0 Mini', prompt: 'x' }, { status: 'generating' })], []);
    const plan = await planRun({ graph: g, active: new Map(), scope: 'all', catalog: fixtureCatalog, ctx: PLUS });
    expect(plan.items[0]).toMatchObject({ action: 'reuse', reason: 'Already running' });
  });
});

describe('planPromptSpec and buildGenerateRequest', () => {
  it('plans a tool-page spec and builds the provider request with signed inputs', async () => {
    const plan = await planPromptSpec({
      spec: { kind: 'video', model: 'Seedance 2.0 Mini', prompt: 'A @[Cat] jumps', seconds: 5, resolution: '480p', ratio: '9:16', inputs: { firstFrameAssetId: 'ast_1' } },
      catalog: fixtureCatalog,
      ctx: PLUS,
      assetOrigins: new Map([['ast_1', { origin: 'mine' as const, media: 'image' as const }]]),
    });
    const item = plan.items[0]!;
    expect(item).toMatchObject({ ref: 'spec', nodeId: null, action: 'run', model: 'bytedance/seedance-2.0-mini' });
    const model = fixtureCatalog.get(item.model!)!;
    const req = buildGenerateRequest(item.spec!, model, [{ input: item.spec!.inputs[0]!, url: 'https://media.test/a.png', origin: 'mine' }]);
    expect(req).toMatchObject({ kind: 'video', mode: 'i2v', prompt: 'A Cat jumps', seconds: 5, resolution: '480p', ratio: '9:16', firstFrameUrl: 'https://media.test/a.png', imageSources: ['mine'] });
  });

  it('blocks a spec whose input asset is unknown', async () => {
    const plan = await planPromptSpec({ spec: { kind: 'image', model: 'auto', prompt: 'x', inputs: { inputAssetIds: ['ast_x'] } }, catalog: fixtureCatalog, ctx: PLUS, assetOrigins: new Map() });
    expect(plan.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input' });
  });

  it('sizes size-based image models from resolution and ratio', () => {
    expect(imageSizeFor('2K', '9:16')).toBe('1536x2752');
    expect(imageSizeFor('1K', '1:1')).toBe('1024x1024');
    expect(imageSizeFor(undefined, undefined)).toBeNull();
    expect(imageSizeFor('8K', '1:1')).toBeNull();
  });
});
