import { describe, expect, it } from 'vitest';
import type { GraphState, LocalOp } from '../graph/types';
import { computeInputDigests } from './digest';
import { applyGraphOps, type RoomOp } from './ops';
import { planRun, type ActiveInfo } from './plan';

function graph(ops: RoomOp[]): GraphState {
  const r = applyGraphOps({ revision: 0, nodes: [], edges: [], groups: [] }, ops);
  if (!r.ok) throw new Error(r.refusal.message);
  return r.state;
}

const base: LocalOp[] = [
  { op: 'addNode', tempId: 'node_P', kind: 'text', title: 'Prompt', params: { text: 'a bottle' } },
  { op: 'addNode', tempId: 'node_K', kind: 'image', title: 'Keyframe', params: {} },
  { op: 'addNode', tempId: 'node_V', kind: 'video', title: 'Shot', params: { prompt: 'push in' } },
  { op: 'connect', from: { node: 'node_P', port: 'out' }, to: { node: 'node_K', port: 'prompt' } },
  { op: 'connect', from: { node: 'node_K', port: 'out' }, to: { node: 'node_V', port: 'frame' } },
];

function setup(state: GraphState, versions: Record<string, string> = {}) {
  const versionIds = new Map(Object.entries(versions).map(([n]) => [n, `ver_${n}`]));
  const digests = computeInputDigests(state, versionIds);
  const active = new Map<string, ActiveInfo>(
    Object.entries(versions).map(([n, mode]) => [n, { versionId: `ver_${n}`, digest: mode === 'fresh' ? digests.get(n)! : 'old', assetId: `ast_${n}` }]),
  );
  return { active, digests };
}

describe('planRun', () => {
  it('runs everything for a fresh graph, keyframe first', () => {
    const s = graph(base);
    const { active, digests } = setup(s);
    const plan = planRun(s, active, digests, 'all');
    expect(plan.map((i) => [i.nodeId, i.action])).toEqual([['node_P', 'none'], ['node_K', 'run'], ['node_V', 'run']]);
    expect(plan[2]!.dependsOn).toEqual(['node_K']);
  });

  it('reuses fresh versions and reruns stale ones', () => {
    const s = graph(base);
    const { active, digests } = setup(s, { node_K: 'fresh', node_V: 'stale' });
    const plan = planRun(s, active, digests, 'all');
    expect(plan.find((i) => i.nodeId === 'node_K')!.action).toBe('reuse');
    expect(plan.find((i) => i.nodeId === 'node_V')).toMatchObject({ action: 'run', inputs: [{ nodeId: 'node_K', assetId: 'ast_node_K', pending: false }] });
  });

  it('supports upTo and from scopes', () => {
    const s = graph(base);
    const { active, digests } = setup(s, { node_K: 'fresh' });
    expect(planRun(s, active, digests, 'upTo', ['node_V']).map((i) => i.action)).toEqual(['none', 'reuse', 'run']);
    expect(planRun(s, active, digests, 'from', ['node_K']).map((i) => [i.nodeId, i.action])).toEqual([['node_K', 'run'], ['node_V', 'run']]);
  });

  it('blocks on missing inputs and handles bypass', () => {
    const s = graph(base);
    const { active, digests } = setup(s);
    expect(planRun(s, active, digests, 'node', ['node_V'])[0]).toMatchObject({ action: 'blocked', reason: 'INPUT_NOT_READY' });
    const bypassed = graph([...base, { op: 'setBypass', nodeId: 'node_K', bypass: true }]);
    const b = setup(bypassed);
    const plan = planRun(bypassed, b.active, b.digests, 'all');
    expect(plan.find((i) => i.nodeId === 'node_K')!.action).toBe('bypassed');
    expect(plan.find((i) => i.nodeId === 'node_V')).toMatchObject({ action: 'blocked', reason: 'BYPASS_TYPE_MISMATCH' });
  });
});
