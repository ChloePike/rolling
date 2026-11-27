/**
 * D-020 "Enhance prompt" (Hyperouter `prompt_expand`): catalog parse, writer
 * choice, cost bound, request bodies (never with `prompt_extend`), planning
 * defaults and quote prices.
 */
import { describe, expect, it } from 'vitest';
import listing from './__fixtures__/hyperouter-models.json';
import { fixtureCatalog, fixtureModel as m } from './__fixtures__/catalog';
import { Catalog, parseListing, priceLines, PROMPT_EXPAND_METER, usdCost } from './catalog';
import {
  DEFAULT_EXPANSION_WRITER,
  expansionWriter,
  planPromptExpansion,
  promptExpansionMaxUsd,
  takesPromptExpand,
} from './expand';
import { validateRequest } from './capabilities';
import { buildImageBody, expandedPromptOf, generationToJobStatus } from './providers/hyperouter/image';
import { buildVideoBody, videoToJobStatus } from './providers/hyperouter/video';
import { expansionFailureOf, HyperouterError } from './providers/hyperouter/client';
import { creditsFor, creditsForUsd, PROMPT_EXPANSION_TOKENS } from '../pricing/config';
import { planPromptSpec } from '../generation/specPlan';
import { planRun as planLayer, replanMature } from '../generation/plan';
import { buildGenerateRequest } from '../generation/request';
import { PromptSpecSchema } from '../generation/spec';
import { planRun as structuralPlan } from '../project/plan';
import { computeInputDigests } from '../project/digest';
import type { GraphNode, GraphState } from '../graph/types';
import type { PlanContext } from '../generation/types';
import type { ListingModel } from './types';

const chat = fixtureCatalog.list({ kind: 'chat', includeHidden: true, includeMatureOnly: true });
const ON: PlanContext = { plan: 'plus', matureAllowed: false, promptExpand: { default: true, available: true } };
const spec = (raw: unknown) => PromptSpecSchema.parse(raw);

function withChat(id: string, prompt: number, completion: number): ListingModel {
  return { ...m('x-ai/grok-4.6'), id, price: [
    { meter: 'prompt', conditions: {}, usd: prompt, minUnits: 0, unitStep: 1 },
    { meter: 'completion', conditions: {}, usd: completion, minUnits: 0, unitStep: 1 },
  ] };
}

describe('catalog: prompt_expand support', () => {
  it('parses params.promptExpand from supported_parameters (media only)', () => {
    expect(m('bytedance/seedream-5.0-flash').params.promptExpand).toBe(true);
    expect(m('bytedance/seedance-2.5').params.promptExpand).toBe(true);
    expect(m('alibaba/wan3.0').params).toMatchObject({ promptExpand: true, promptExtend: true });
    expect(m('lumina/wan2.7-i2v-spicy').params.promptExpand).toBe(false);
    expect(m('x-ai/grok-4.6').params.promptExpand).toBe(false);
  });

  it('is false for a listing that does not name it (account without the feature)', () => {
    const raw = structuredClone((listing as { data: Record<string, unknown>[] }).data.find((e) => e.id === 'bytedance/seedream-5.0-flash')!);
    raw.supported_parameters = (raw.supported_parameters as string[]).filter((p) => p !== 'prompt_expand');
    expect(parseListing({ data: [raw] }).models[0]!.params.promptExpand).toBe(false);
  });

  it('takes it only for creates', () => {
    const wan = m('alibaba/wan3.0');
    expect(takesPromptExpand(wan, 't2v')).toBe(true);
    expect(takesPromptExpand(wan, 'i2v')).toBe(true);
    expect(takesPromptExpand(wan, 'extend')).toBe(false);
    expect(takesPromptExpand(m('lumina/wan2.7-i2v-spicy'), 'i2v')).toBe(false);
  });
});

describe('writer and cost bound', () => {
  it('non-mature runs: the cheapest DeepSeek V4.1 Flash route', () => {
    expect(expansionWriter(chat, { mature: false })).toBe('deepseek/deepseek-v4.1-flash-us');
  });

  it('mature runs: Grok 4.7, else Grok 4.6, else the gateway default (owner decision)', () => {
    expect(expansionWriter([...chat, withChat('x-ai/grok-4.7', 0.000002, 0.000006)], { mature: true })).toBe('x-ai/grok-4.7');
    expect(expansionWriter(chat, { mature: true })).toBe('x-ai/grok-4.6');
    expect(expansionWriter(chat.filter((c) => !c.id.startsWith('x-ai/')), { mature: true })).toBeNull();
    expect(expansionWriter([], { mature: false })).toBeNull();
  });

  it('bounds the rewrite at the writer token prices', () => {
    const t = PROMPT_EXPANSION_TOKENS;
    const ds = promptExpansionMaxUsd(chat, 'deepseek/deepseek-v4.1-flash-us', { promptChars: 100, pictures: 2 });
    expect(ds).toBeCloseTo((t.instructions + 100 + 2 * t.perPicture) * 0.000000075 + t.output * 0.0000003, 9);
    // Null writer = the gateway default, priced as Grok 4.6.
    const grok = promptExpansionMaxUsd(chat, null, { promptChars: 100 });
    expect(grok).toBeCloseTo((t.instructions + 100) * 0.000002 + t.output * 0.000006, 9);
    expect(promptExpansionMaxUsd(chat, DEFAULT_EXPANSION_WRITER, { promptChars: 100 })).toBe(grok);
    // Pictures are capped at 5.
    expect(promptExpansionMaxUsd(chat, null, { promptChars: 0, pictures: 9 })).toBe(promptExpansionMaxUsd(chat, null, { promptChars: 0, pictures: 5 }));
    // Mature runs are priced at Grok.
    expect(planPromptExpansion(chat, { mature: true, promptChars: 100 })).toEqual({ writer: 'x-ai/grok-4.6', maxUsd: grok });
  });

  it('prices the expansion with the render only on models that take it', () => {
    const flash = m('bytedance/seedream-5.0-flash');
    const base = usdCost(flash)!;
    expect(usdCost(flash, { promptExpandUsd: 0.004 })).toBeCloseTo(base + 0.004, 9);
    expect(priceLines(flash, { promptExpandUsd: 0.004 })!.find((l) => l.meter === PROMPT_EXPAND_METER)).toMatchObject({ usd: 0.004 });
    expect(creditsFor(flash, { promptExpandUsd: 0.004 })).toBe(creditsForUsd(base + 0.004));
    const spicy = m('lumina/wan2.7-i2v-spicy');
    expect(usdCost(spicy, { promptExpandUsd: 0.004, seconds: 5 })).toBe(usdCost(spicy, { seconds: 5 }));
  });
});

describe('request bodies', () => {
  it('sends prompt_expand, the writer and the locale, and never prompt_extend', () => {
    const wan = m('alibaba/wan3.0');
    const body = buildVideoBody(wan, { kind: 'video', mode: 't2v', prompt: 'a fox', seconds: 5, promptExpand: { model: 'deepseek/deepseek-v4.1-flash-us', locale: 'ja' }, extra: { prompt_extend: true } }, 'auto');
    expect(body).toMatchObject({ prompt_expand: true, prompt_expand_model: 'deepseek/deepseek-v4.1-flash-us', locale: 'ja' });
    expect(body).not.toHaveProperty('prompt_extend');
    const img = buildImageBody(m('bytedance/seedream-5.0-flash'), { kind: 'image', mode: 't2i', prompt: 'a fox', promptExpand: {} }, 'auto');
    expect(img).toMatchObject({ prompt_expand: true });
    expect(img).not.toHaveProperty('prompt_expand_model');
    expect(img).not.toHaveProperty('locale');
  });

  it('sends nothing of it when the run does not ask, on extend, or on a model without it', () => {
    const wan = m('alibaba/wan3.0');
    expect(buildVideoBody(wan, { kind: 'video', mode: 't2v', prompt: 'a fox', extra: { prompt_expand: true, locale: 'x' } }, 'auto')).not.toHaveProperty('prompt_expand');
    expect(buildVideoBody(wan, { kind: 'video', mode: 'extend', prompt: 'more', promptExpand: {} }, 'auto')).not.toHaveProperty('prompt_expand');
    const spicy = m('lumina/wan2.7-i2v-spicy');
    expect(buildVideoBody(spicy, { kind: 'video', mode: 'i2v', prompt: 'x', firstFrameUrl: 'https://a/b.png', promptExpand: {} }, 'low')).not.toHaveProperty('prompt_expand');
    expect(validateRequest(spicy, { kind: 'video', mode: 'i2v', prompt: 'x', firstFrameUrl: 'https://a/b.png', seconds: 2, promptExpand: {} })).toContain('promptExpand not supported');
  });

  it('reads expanded_prompt from image, generation and video answers', () => {
    expect(generationToJobStatus({ id: 'g', kind: 'image', status: 'done', expanded_prompt: 'A fox, golden hour', outputs: [] }).expandedPrompt).toBe('A fox, golden hour');
    expect(generationToJobStatus({ id: 'g', kind: 'image', status: 'done', expanded_prompt: null }).expandedPrompt).toBeNull();
    expect(generationToJobStatus({ id: 'g', kind: 'image', status: 'done' })).not.toHaveProperty('expandedPrompt');
    expect(videoToJobStatus({ id: 'v', status: 'in_progress', expanded_prompt: 'Second 1: ...' }).expandedPrompt).toBe('Second 1: ...');
    expect(expandedPromptOf('  ')).toBeNull();
  });

  it('classifies expansion failures', () => {
    const e = (status: number, code: string, param: string | null = null) => new HyperouterError({ status, type: 'x', code, message: code, param, retryable: false });
    expect(expansionFailureOf(e(403, 'feature_not_enabled', 'prompt_expand'))).toBe('feature_off');
    expect(expansionFailureOf(e(422, 'expansion_refused'))).toBe('refused');
    expect(expansionFailureOf(e(403, 'model_not_enabled', 'prompt_expand_model'))).toBe('writer');
    expect(expansionFailureOf(e(403, 'model_not_enabled', 'model'))).toBeNull();
    expect(expansionFailureOf(e(400, 'content_rejected'))).toBeNull();
    expect(expansionFailureOf(new Error('x'))).toBeNull();
  });
});

describe('planning (Home, tools, Quick Create, canvas)', () => {
  it('Quick Create: on by the preference; quoted with its most; the request asks for it', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'a red bicycle' }), catalog: fixtureCatalog, ctx: ON, assetOrigins: new Map() });
    const item = plan.items[0]!;
    expect(item.spec!.promptExpand).toEqual({ writer: 'deepseek/deepseek-v4.1-flash-us', maxUsd: promptExpansionMaxUsd(chat, 'deepseek/deepseek-v4.1-flash-us', { promptChars: 'a red bicycle'.length }) });
    expect(item.priceRequest!.promptExpandUsd).toBe(item.spec!.promptExpand!.maxUsd);
    const model = m('bytedance/seedream-5.0-flash');
    const { promptExpandUsd: _drop, ...plain } = item.priceRequest!;
    expect(creditsFor(model, item.priceRequest)).toBeGreaterThanOrEqual(creditsFor(model, plain));
    expect(buildGenerateRequest(item.spec!, model, []).promptExpand).toEqual({ model: 'deepseek/deepseek-v4.1-flash-us' });
  });

  it('per-run off, preference off, feature unavailable, or no context: no expansion', async () => {
    const plan = (s: Record<string, unknown>, ctx: PlanContext) =>
      planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'a red bicycle', ...s }), catalog: fixtureCatalog, ctx, assetOrigins: new Map() });
    for (const [s, ctx] of [
      [{ promptExpand: false }, ON],
      [{}, { ...ON, promptExpand: { default: false, available: true } }],
      [{ promptExpand: true }, { ...ON, promptExpand: { default: true, available: false } }],
      [{ promptExpand: true }, { plan: 'plus', matureAllowed: false }],
    ] as const) {
      const item = (await plan(s, ctx as PlanContext)).items[0]!;
      expect(item.spec!.promptExpand).toBeUndefined();
      expect(item.priceRequest!.promptExpandUsd).toBeUndefined();
    }
    // Per-run on beats a preference that is off.
    const on = (await plan({ promptExpand: true }, { ...ON, promptExpand: { default: false, available: true } })).items[0]!;
    expect(on.spec!.promptExpand).toBeDefined();
  });

  it('Auto on a model without it: kept on the spec, not priced or sent', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'video', model: 'lumina/wan2.2-i2v-spicy', prompt: 'she turns', inputs: { firstFrameAssetId: 'ast_gen' } }), catalog: fixtureCatalog, ctx: { ...ON, matureAllowed: true }, assetOrigins: new Map([['ast_gen', { origin: 'generated', media: 'image' }]]) });
    const item = plan.items[0]!;
    expect(item.action).toBe('run');
    // wan2.2-i2v-spicy lists prompt_expand in the fixture: priced. A model without it would not be (see the spicy 2.7 body test).
    expect(item.priceRequest!.promptExpandUsd === undefined).toBe(!m(item.model!).params.promptExpand);
  });

  it('mature re-plan in prepare switches the writer to Grok and re-bounds it', async () => {
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'a red bicycle' }), catalog: fixtureCatalog, ctx: ON, assetOrigins: new Map() });
    const item = plan.items[0]!;
    const r = replanMature({ spec: item.spec!, model: m(item.model!), catalog: fixtureCatalog, plan: 'plus', fits: () => true });
    if (!r.ok) throw new Error(r.reason);
    expect(r.spec.promptExpand).toMatchObject({ writer: 'x-ai/grok-4.6' });
    expect(r.spec.promptExpand!.maxUsd).toBeGreaterThan(item.spec!.promptExpand!.maxUsd);
  });

  it('canvas: agent-planned nodes default off; user nodes follow the preference; a node can turn it on', async () => {
    const node = (id: string, createdBy: 'user' | 'agent', params: Record<string, unknown> = {}): GraphNode => ({
      id, kind: 'image', title: id, params: { model: 'bytedance/seedream-5.0-flash', prompt: 'A bottle on a rock', ...params }, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy,
    });
    const graph: GraphState = { revision: 1, nodes: [node('mine', 'user'), node('agent', 'agent'), node('agentOn', 'agent', { promptExpand: true }), node('mineOff', 'user', { promptExpand: false })], edges: [], groups: [] };
    const digests = computeInputDigests(graph, new Map());
    const structural = structuralPlan(graph, new Map(), digests, 'all', []);
    const plan = await planLayer({ graph, structural, catalog: fixtureCatalog, ctx: ON });
    const by = Object.fromEntries(plan.items.map((i) => [i.ref, i]));
    expect(by.mine!.spec!.promptExpand).toBeDefined();
    expect(by.agent!.spec!.promptExpand).toBeUndefined();
    expect(by.agentOn!.spec!.promptExpand).toBeDefined();
    expect(by.mineOff!.spec!.promptExpand).toBeUndefined();
  });

  it('the catalog without chat models falls back to the gateway default writer', async () => {
    const media = new Catalog(fixtureCatalog.models.filter((x) => x.kind !== 'chat'));
    const plan = await planPromptSpec({ spec: spec({ kind: 'image', model: 'bytedance/seedream-5.0-flash', prompt: 'x' }), catalog: media, ctx: ON, assetOrigins: new Map() });
    expect(plan.items[0]!.spec!.promptExpand).toMatchObject({ writer: null });
    expect(buildGenerateRequest(plan.items[0]!.spec!, m('bytedance/seedream-5.0-flash'), []).promptExpand).toEqual({});
  });
});
