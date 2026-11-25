import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { findModel } from '../generation/spec';
import { planRun as planLayer } from '../generation/plan';
import { applyGraphOps } from '../project/ops';
import { computeInputDigests } from '../project/digest';
import { planRun as structuralPlan } from '../project/plan';
import { templateOps } from '../project/template';
import type { GraphState } from '../graph/types';
import { BUILTIN_TEMPLATES, builtinTemplatesSql } from './builtin';
import { fillSlots, inferSlots, selectionGraph, SlotFillError, summarizeGraph } from './slots';

const EMPTY: GraphState = { revision: 0, nodes: [], edges: [], groups: [] };

describe('built-in templates', () => {
  it('has 6–10 templates with unique ids, real catalog models and Starter-safe settings', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(BUILTIN_TEMPLATES.length).toBeLessThanOrEqual(10);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    for (const t of BUILTIN_TEMPLATES) {
      for (const n of t.graph.nodes) {
        if (n.kind !== 'image' && n.kind !== 'video') continue;
        const model = findModel(fixtureCatalog, String(n.params.model));
        expect(model?.id, `${t.id}/${n.id}`).toBe(n.params.model);
        if (n.kind === 'video') expect(n.params.resolution).toBe('720p');
      }
    }
  });

  it('every template graph applies as a valid patch, and once its slots are filled every generative node plans to run on Starter', async () => {
    for (const t of BUILTIN_TEMPLATES) {
      const slots = inferSlots(t.graph);
      const fills = Object.fromEntries(slots.filter((s) => s.param === 'assetId').map((s) => [s.id, { assetId: `ast_${s.id}` }]));
      const filled = fillSlots(t.graph, fills);
      const applied = applyGraphOps(EMPTY, templateOps(filled));
      expect(applied.ok, `${t.id}: ${JSON.stringify(!applied.ok && applied.refusal)}`).toBe(true);
      if (!applied.ok) continue;
      // Asset nodes carry their media `source` for D-005 provenance; uploads are fine for non-mature runs.
      const state = applied.state;
      const digests = computeInputDigests(state, new Map());
      const structural = structuralPlan(state, new Map(), digests, 'all');
      const plan = await planLayer({ graph: state, structural, catalog: fixtureCatalog, ctx: { plan: 'starter', matureAllowed: false } });
      const generative = plan.items.filter((i) => i.kind === 'image' || i.kind === 'video');
      expect(generative.length, t.id).toBeGreaterThan(0);
      for (const i of generative) expect(i.action, `${t.id}/${i.title}: ${i.reason ?? ''}`).toBe('run');
    }
  });

  it('writes an idempotent upsert per template', () => {
    const sql = builtinTemplatesSql();
    expect(sql.match(/INSERT INTO templates/g)).toHaveLength(BUILTIN_TEMPLATES.length);
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
  });
});

describe('slots', () => {
  const tv = BUILTIN_TEMPLATES.find((t) => t.id === 'tpl_tv_ad_15s')!;

  it('infers a slot per asset and text node', () => {
    const slots = inferSlots(tv.graph);
    expect(slots.map((s) => [s.id, s.kind, s.param, s.required])).toEqual([
      ['script', 'text', 'text', false],
      ['product', 'image', 'assetId', true],
    ]);
    expect(tv.meta).toMatchObject({ durationSec: 15, ratio: '16:9', roles: 1, hasLines: true, nodeCount: 8 });
  });

  it('fills assets and text and refuses unknown or mismatched slots', () => {
    const g = fillSlots(tv.graph, { product: { assetId: 'ast_1' }, script: { text: 'New script' } });
    expect(g.nodes.find((n) => n.id === 'product')!.params.assetId).toBe('ast_1');
    expect(g.nodes.find((n) => n.id === 'script')!.params.text).toBe('New script');
    expect(() => fillSlots(tv.graph, { nope: { text: 'x' } })).toThrow(SlotFillError);
    expect(() => fillSlots(tv.graph, { product: { text: 'x' } })).toThrow(SlotFillError);
  });

  it('turns a canvas selection into a template graph at the origin without run state', () => {
    const state: GraphState = {
      revision: 7,
      nodes: [
        { id: 'a', kind: 'asset', title: 'Photo', params: { media: 'image', assetId: 'ast_x' }, position: { x: 500, y: 300 }, groupId: 'g1', status: 'done', createdBy: 'user', version: { n: 2, total: 2 } },
        { id: 'b', kind: 'image', title: 'Still', params: { prompt: 'p' }, position: { x: 800, y: 340 }, groupId: 'g1', status: 'done', createdBy: 'agent', cost: 9 },
        { id: 'c', kind: 'video', title: 'Out', params: {}, position: { x: 1200, y: 300 }, groupId: null, status: 'idle', createdBy: 'user' },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'refs' } },
        { id: 'e2', from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'frame' } },
      ],
      groups: [{ id: 'g1', title: 'Look', nodeIds: ['a', 'b'] }],
    };
    const g = selectionGraph(state, ['a', 'b']);
    expect(g.nodes.map((n) => [n.id, n.position, n.status, n.createdBy])).toEqual([
      ['a', { x: 0, y: 0 }, 'idle', 'user'],
      ['b', { x: 300, y: 40 }, 'idle', 'user'],
    ]);
    expect(g.nodes[0]).not.toHaveProperty('version');
    expect(g.edges.map((e) => e.id)).toEqual(['e1']);
    expect(g.groups.map((x) => x.id)).toEqual(['g1']);
    expect(inferSlots(g)).toEqual([{ id: 'a', kind: 'image', label: 'Photo', param: 'assetId', required: false, default: 'ast_x' }]);
    expect(summarizeGraph(g)).toMatchObject({ roles: 1, nodeCount: 2, durationSec: 0 });
    // A group cut by the selection is dropped.
    expect(selectionGraph(state, ['b', 'c']).groups).toEqual([]);
  });
});
