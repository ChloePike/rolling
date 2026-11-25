import { MockProjectRoom } from './graph/mockRoom';
import { GraphStore } from './graph/store';
import { ProjectSync, type SyncEvents } from './graph/sync';
import type { GraphEdge, GraphNode } from '@rolling/core/graph';
import { mockGraph, MOCK_ACCOUNT, MOCK_CREDITS, MOCK_PROJECT, MOCK_SHARE } from './mocks';

/**
 * The canvas talks to the backend only through this file. Today everything
 * runs on an in-browser ProjectRoom mock that speaks the real envelope
 * protocol; swap `connect` for `webSocketTransport('/api/projects/:id/ws')`
 * and the REST calls for fetches when the API lands.
 */

export interface ProjectSession {
  store: GraphStore;
  sync: ProjectSync;
  dispose: () => void;
}

declare global {
  interface Window {
    /** Test hook: the mock ProjectRoom of the open canvas (mock mode only). */
    __canvasRoom?: MockProjectRoom;
  }
}

function mockFlags() {
  const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  return { frozen: q.get('mock') === 'frozen', fast: q.get('mock') === 'fast', guest: q.get('member') === '0' };
}

let room: MockProjectRoom | null = null;

export function openProject(projectId: string, events: SyncEvents): ProjectSession {
  const flags = mockFlags();
  room?.dispose();
  room = new MockProjectRoom({
    projectId,
    initial: mockGraph(),
    frozen: flags.frozen,
    latency: flags.fast ? 0 : 40,
    tick: flags.fast ? 60 : 450,
  });
  window.__canvasRoom = room;
  const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
  const sync = new ProjectSync(store, room.connect(), events);
  return {
    store,
    sync,
    dispose: () => sync.dispose(),
  };
}

export function getProject(projectId: string) {
  return { ...MOCK_PROJECT, id: projectId };
}

/**
 * `GET /api/me` (mock). `isMember` defaults to true so the design states stay
 * as drawn; `?member=0` opens the canvas as a signed-up non-member (D-007).
 */
export function getAccount(): { plan: typeof MOCK_ACCOUNT.plan; isMember: boolean } {
  return { ...MOCK_ACCOUNT, isMember: MOCK_ACCOUNT.isMember && !mockFlags().guest };
}

/** Checkout (`POST /api/billing/checkout`) — the mock completes at once. */
export async function checkoutPlan(_planId: string): Promise<{ isMember: true }> {
  return { isMember: true };
}

export function getCredits() {
  return MOCK_CREDITS;
}

export function getShare() {
  return MOCK_SHARE;
}

export type QuoteAction = 'run' | 'reuse' | 'blocked' | 'none';

export interface QuoteItem {
  nodeId: string;
  action: QuoteAction;
  model: string;
  credits: number;
  reason?: string;
}

/** Sources first, then the nodes they feed (the order runs happen in). */
function dependencyOrder(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (ids.has(e.from.node) && ids.has(e.to.node)) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  const out: GraphNode[] = [];
  const left = [...nodes];
  while (left.length) {
    const i = Math.max(0, left.findIndex((n) => (indeg.get(n.id) ?? 0) === 0));
    const [n] = left.splice(i, 1);
    out.push(n!);
    for (const e of edges) if (e.from.node === n!.id) indeg.set(e.to.node, (indeg.get(e.to.node) ?? 1) - 1);
  }
  return out;
}

/** `POST /api/runs/quote` (scope all / selection / node). */
export function quoteRun(nodes: GraphNode[], edges: GraphEdge[], nodeIds?: string[]): { quoteId: string; items: QuoteItem[]; total: number; balanceAfter: number } {
  const picked = dependencyOrder(nodeIds ? nodes.filter((n) => nodeIds.includes(n.id)) : nodes, edges);
  const items: QuoteItem[] = picked
    .map((n) => {
      const model = typeof n.params.model === 'string' ? n.params.model : '';
      if (n.kind === 'script' || n.kind === 'text' || n.kind === 'asset') return { nodeId: n.id, action: 'none', model, credits: 0 };
      if (n.status === 'generating' || n.status === 'queued') return { nodeId: n.id, action: 'reuse', model, credits: 0, reason: 'Already running' };
      if (n.status === 'done') return { nodeId: n.id, action: 'reuse', model, credits: 0 };
      return { nodeId: n.id, action: 'run', model, credits: n.cost ?? (typeof n.params.runCost === 'number' ? n.params.runCost : 0) };
    });
  const total = items.reduce((s, i) => s + (i.action === 'run' ? i.credits : 0), 0);
  return { quoteId: `qt_${Date.now()}`, items, total, balanceAfter: MOCK_CREDITS.balance - total };
}

/** `POST /api/runs { quoteId }`: holds credits and starts one job per `run` item. */
export function startRun(nodeIds: string[]) {
  room?.startJobs(nodeIds);
  return { runId: `run_${Date.now()}` };
}

/** `POST /api/projects/:id/share`. */
export function publishShare() {
  return { ...MOCK_SHARE, snapshotAt: new Date() };
}
