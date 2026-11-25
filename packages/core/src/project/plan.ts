/**
 * Run planning (what "Run" would do), computed by ProjectRoom from the graph,
 * active versions and input digests. Pricing is not done here: the quote
 * route prices the `run` items through CreditAccount.
 *
 * Scopes: `node` (one node), `selection` (the given nodes), `all` (every
 * node), `upTo` (the node plus its upstream that still needs a run) and
 * `from` (the node plus everything downstream), the last two from
 * `@rolling/core/graph` `runScopeNodes` so the canvas and the server agree.
 *
 * Actions per node:
 * - `run`: generates (explicitly targeted, never ran, inputs changed, or an upstream in this plan runs);
 * - `reuse`: has a version made with the current inputs;
 * - `blocked`: cannot run (missing prompt, an input without output, a bypassed upstream whose type differs);
 * - `bypassed`: the node is bypassed; its input passes through when the types match;
 * - `none`: nothing to generate (text, script, asset, render).
 */
import { bypassSource, runScopeNodes } from '../graph/ops';
import { inputPorts } from '../graph/ports';
import type { GraphNode, GraphState, NodeKind } from '../graph/types';
import { nodeFlags } from './ops';

export type RunScope = 'node' | 'selection' | 'all' | 'upTo' | 'from';
export type PlanAction = 'run' | 'reuse' | 'blocked' | 'bypassed' | 'none';

export type BlockReason = 'NO_PROMPT' | 'INPUT_NOT_READY' | 'BYPASS_TYPE_MISMATCH' | 'UPSTREAM_BLOCKED';

export interface PlanInput {
  port: string;
  /** Node whose output feeds this input (after bypass pass-through). */
  nodeId: string;
  /** Its active asset when it already has one; null when it runs in this plan. */
  assetId: string | null;
  /** The upstream runs in this plan: this item must wait for it. */
  pending: boolean;
}

export interface PlanItem {
  nodeId: string;
  kind: NodeKind;
  title: string;
  action: PlanAction;
  reason?: BlockReason;
  /** Human-readable reason (English) for `blocked` / `bypassed`. */
  message?: string;
  /** `params.model` as set on the node (null = Auto). */
  model: string | null;
  params: Record<string, unknown>;
  /** Digest a version made by this run would record (pass to `addVersion`). */
  inputDigest: string;
  inputs: PlanInput[];
  /** Plan items this one waits for (upstream `run` items). */
  dependsOn: string[];
}

export interface ActiveInfo {
  versionId: string;
  digest: string;
  assetId: string | null;
}

const GENERATIVE: ReadonlySet<NodeKind> = new Set<NodeKind>(['image', 'video', 'audio']);

function hasPromptText(node: GraphNode): boolean {
  const p = node.params.prompt ?? node.params.text;
  return typeof p === 'string' && p.trim().length > 0;
}

/** Topological order (inputs first), stable by the state's node order. */
function topo(state: GraphState): GraphNode[] {
  const indeg = new Map(state.nodes.map((n) => [n.id, 0]));
  for (const e of state.edges) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  const queue = state.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  const out: GraphNode[] = [];
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const e of state.edges) {
      if (e.from.node !== n.id) continue;
      const d = (indeg.get(e.to.node) ?? 0) - 1;
      indeg.set(e.to.node, d);
      if (d === 0) queue.push(byId.get(e.to.node)!);
    }
  }
  return out;
}


export function planRun(
  state: GraphState,
  active: ReadonlyMap<string, ActiveInfo>,
  digests: ReadonlyMap<string, string>,
  scope: RunScope,
  nodeIds: readonly string[] = [],
): PlanItem[] {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const explicit = new Set<string>();
  let targets: Set<string>;
  switch (scope) {
    case 'all':
      targets = new Set(state.nodes.map((n) => n.id));
      break;
    case 'node':
    case 'selection':
      targets = new Set(nodeIds.filter((id) => byId.has(id)));
      for (const id of targets) explicit.add(id);
      break;
    case 'upTo':
    case 'from': {
      // Same node sets as the canvas ("Run up to here" / "Run from here"): core/graph runScopeNodes.
      const root = nodeIds[0];
      targets = root && byId.has(root) ? new Set(runScopeNodes(state, root, scope)) : new Set();
      if (root) explicit.add(root);
      break;
    }
  }

  const items = new Map<string, PlanItem>();
  const isFresh = (id: string) => {
    const a = active.get(id);
    return !!a && a.digest === digests.get(id);
  };

  /** Where a node's output comes from: itself, or for a bypassed node its pass-through source (core/graph). */
  const source = (id: string): { nodeId: string } | { broken: string; message: string } => {
    if (!nodeFlags(byId.get(id)!).bypass) return { nodeId: id };
    const r = bypassSource(state, id);
    return r.ok ? { nodeId: r.source } : { broken: id, message: r.reason.message };
  };

  for (const node of topo(state)) {
    if (!targets.has(node.id)) continue;
    const base = {
      nodeId: node.id,
      kind: node.kind,
      title: node.title,
      model: typeof node.params.model === 'string' && node.params.model !== 'auto' ? node.params.model : null,
      params: node.params,
      inputDigest: digests.get(node.id) ?? '',
    };
    if (nodeFlags(node).bypass) {
      const s = source(node.id);
      items.set(node.id, {
        ...base,
        action: 'bypassed',
        message: 'nodeId' in s ? 'Bypassed: its input passes through.' : 'Bypassed: nothing of the same type to pass through.',
        inputs: [],
        dependsOn: [],
      });
      continue;
    }
    if (!GENERATIVE.has(node.kind)) {
      items.set(node.id, { ...base, action: 'none', inputs: [], dependsOn: [] });
      continue;
    }

    const inputs: PlanInput[] = [];
    let blocked: { reason: BlockReason; message: string } | null = null;
    for (const e of state.edges.filter((x) => x.to.node === node.id)) {
      const s = source(e.from.node);
      if (!('nodeId' in s)) {
        blocked ??= { reason: 'BYPASS_TYPE_MISMATCH', message: s.message };
        continue;
      }
      const up = byId.get(s.nodeId)!;
      const upItem = items.get(up.id);
      if (upItem?.action === 'blocked') {
        blocked ??= { reason: 'UPSTREAM_BLOCKED', message: `Waiting on “${up.title}”, which can’t run.` };
        continue;
      }
      const pending = upItem?.action === 'run';
      const generative = GENERATIVE.has(up.kind);
      const asset = active.get(up.id)?.assetId ?? null;
      if (generative && !pending && !active.has(up.id)) {
        blocked ??= { reason: 'INPUT_NOT_READY', message: `“${up.title}” has no output yet.` };
        continue;
      }
      inputs.push({ port: e.to.port, nodeId: up.id, assetId: pending ? null : asset, pending });
    }
    const promptPort = inputPorts(node).some((p) => p.name === 'prompt');
    const hasPrompt = hasPromptText(node) || inputs.some((i) => i.port === 'prompt') || inputs.some((i) => i.port === 'frame' || i.port === 'refs');
    if (!blocked && promptPort && !hasPrompt) blocked = { reason: 'NO_PROMPT', message: 'Add a prompt first.' };
    if (blocked) {
      items.set(node.id, { ...base, action: 'blocked', ...blocked, inputs, dependsOn: [] });
      continue;
    }
    const dependsOn = inputs.filter((i) => i.pending).map((i) => i.nodeId);
    const run = explicit.has(node.id) || !isFresh(node.id) || dependsOn.length > 0;
    items.set(node.id, { ...base, action: run ? 'run' : 'reuse', inputs, dependsOn });
  }
  return [...items.values()];
}
