import { useSyncExternalStore } from 'react';
import { checkoutTopUp, getCredits as getSessionCredits } from '@/lib/session';
import { MockProjectRoom } from './graph/mockRoom';
import { GraphStore } from './graph/store';
import { ProjectSync, type SyncEvents } from './graph/sync';
import { blockedByBypass, runScopeNodes, type GraphEdge, type GraphNode, type LocalOp, type RunScope } from '@rolling/core/graph';
import { mockGraph, MOCK_AGENT, MOCK_AGENT_OPTIONS, MOCK_PROJECT, MOCK_SHARE, type AgentPlanOption } from './mocks';

/**
 * The canvas talks to the backend only through this file. Today everything
 * runs on an in-browser ProjectRoom mock that speaks the real envelope
 * protocol; swap `connect` for `webSocketTransport('/api/projects/:id/ws')`
 * and the REST calls for fetches when the API lands.
 *
 * Mock flags (`?mock=`): `frozen` (jobs never advance), `fast` (no latency,
 * quick ticks), `fail` (every new job fails at 40% and refunds).
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
  const mock = q.get('mock');
  return { frozen: mock === 'frozen', fast: mock === 'fast', fail: mock === 'fail' };
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage unavailable: the change lives until reload. */
  }
}

/** Tiny observable store for mock server state the canvas renders. */
function observable<T>(initial: () => T) {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const get = () => (value ??= initial());
  return {
    get,
    set(next: T) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    reset() {
      value = null;
    },
  };
}

/* ---------- Credits (CreditAccount: quote → hold → settle | release) ---------- */

export interface CanvasCredits {
  available: number;
  plan: number;
  purchased: number;
  planExpires: Date;
  usedThisMonth: number;
  held: number;
  expiringThisMonth: number;
}

// Seeded from the shared session credits (lib/session); afterwards the project
// socket's `credits.changed` keeps it live. TODO(session): feed credits.changed
// into lib/session once it exposes a setter, so the header and canvas share one store.
const credits = observable<CanvasCredits>(() => ({ ...getSessionCredits() }));

/** `credits.changed { balance, held }` from the room: spends plan credits first, refunds go back to the plan. */
function applyCredits(balance: number, held: number) {
  const c = credits.get();
  const delta = balance - c.available;
  const fromPlan = delta < 0 ? Math.min(c.plan, -delta) : 0;
  const plan = delta < 0 ? c.plan - fromPlan : c.plan + delta;
  const purchased = delta < 0 ? c.purchased - (-delta - fromPlan) : c.purchased;
  // Settled = credits that left the hold without returning to the balance.
  const settled = -(delta + (held - c.held));
  credits.set({ ...c, available: balance, held, plan, purchased, usedThisMonth: c.usedThisMonth + Math.max(0, settled) });
}

export function getCredits(): CanvasCredits {
  return credits.get();
}

export function useCredits(): CanvasCredits {
  return useSyncExternalStore(credits.subscribe, credits.get, credits.get);
}

/* ---------- Project session ---------- */

let room: MockProjectRoom | null = null;

export function openProject(projectId: string, events: SyncEvents): ProjectSession {
  const flags = mockFlags();
  room?.dispose();
  const c = credits.get();
  room = new MockProjectRoom({
    projectId,
    initial: mockGraph(),
    frozen: flags.frozen,
    failAll: flags.fail,
    latency: flags.fast ? 0 : 40,
    tick: flags.fast ? 60 : 450,
    credits: { balance: c.available, held: c.held },
  });
  window.__canvasRoom = room;
  const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
  const sync = new ProjectSync(store, room.connect(), {
    ...events,
    onCredits: (balance, held) => {
      applyCredits(balance, held);
      events.onCredits?.(balance, held);
    },
  });
  return {
    store,
    sync,
    dispose: () => sync.dispose(),
  };
}

/* ---------- Project title (`PATCH /api/projects/:id { title }`) ---------- */

const titleKey = (id: string) => `rolling.canvas.title.${id}`;
const titles = observable<Record<string, string>>(() => ({}));

export function getProject(projectId: string) {
  const saved = titles.get()[projectId] ?? read<string>(titleKey(projectId));
  return { ...MOCK_PROJECT, id: projectId, title: saved ?? MOCK_PROJECT.title };
}

export function useProject(projectId: string) {
  useSyncExternalStore(titles.subscribe, titles.get, titles.get);
  return getProject(projectId);
}

export async function renameProject(projectId: string, title: string): Promise<{ ok: true; title: string } | { ok: false; code: 'EMPTY_TITLE' }> {
  const t = title.trim().slice(0, 120);
  if (!t) return { ok: false, code: 'EMPTY_TITLE' };
  write(titleKey(projectId), t);
  titles.set({ ...titles.get(), [projectId]: t });
  return { ok: true, title: t };
}

/* ---------- Share (`/api/projects/:id/share`) ---------- */

export type ShareAudience = 'link' | 'workspace';

export interface ShareSettings {
  /** False after "Stop sharing": the link no longer opens. */
  active: boolean;
  url: string;
  snapshotAt: Date;
  audience: ShareAudience;
  allowDownloads: boolean;
  showPrompt: boolean;
}

const shareKey = (id: string) => `rolling.canvas.share.${id}`;
type StoredShare = Omit<ShareSettings, 'snapshotAt'> & { snapshotAt: string };
const shares = observable<Record<string, ShareSettings>>(() => ({}));

function defaultShare(): ShareSettings {
  return { active: true, url: MOCK_SHARE.url, snapshotAt: MOCK_SHARE.snapshotAt, audience: 'link', allowDownloads: false, showPrompt: true };
}

export function getShare(projectId = MOCK_PROJECT.id): ShareSettings {
  const cached = shares.get()[projectId];
  if (cached) return cached;
  const stored = read<StoredShare>(shareKey(projectId));
  return stored ? { ...defaultShare(), ...stored, snapshotAt: new Date(stored.snapshotAt) } : defaultShare();
}

export function useShare(projectId: string): ShareSettings {
  useSyncExternalStore(shares.subscribe, shares.get, shares.get);
  return getShare(projectId);
}

function saveShare(projectId: string, next: ShareSettings): ShareSettings {
  write(shareKey(projectId), { ...next, snapshotAt: next.snapshotAt.toISOString() });
  shares.set({ ...shares.get(), [projectId]: next });
  return next;
}

/** `PATCH /api/projects/:id/share`. */
export async function updateShare(projectId: string, patch: Partial<Pick<ShareSettings, 'audience' | 'allowDownloads' | 'showPrompt'>>): Promise<ShareSettings> {
  return saveShare(projectId, { ...getShare(projectId), ...patch });
}

/** `DELETE /api/projects/:id/share`: the link stops working. */
export async function stopSharing(projectId: string): Promise<ShareSettings> {
  return saveShare(projectId, { ...getShare(projectId), active: false });
}

/** `POST /api/projects/:id/share`: a new snapshot (and a link again after stopping). */
export async function publishShare(projectId: string = MOCK_PROJECT.id): Promise<ShareSettings> {
  const cur = getShare(projectId);
  const url = cur.active ? cur.url : `${MOCK_SHARE.url.replace(/\/s\/.*/, '')}/s/${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`;
  return saveShare(projectId, { ...cur, active: true, url, snapshotAt: new Date() });
}

/* ---------- Runs ---------- */

export type QuoteAction = 'run' | 'reuse' | 'blocked' | 'bypassed' | 'none';

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

export type QuoteScope = RunScope;

/**
 * `POST /api/runs/quote { scope, nodeIds }`. Scopes: `all` (the whole
 * canvas, current versions reused), `node` (regenerates the node), `upTo`
 * (the node and its stale upstream), `from` (the node and everything it
 * feeds). Bypassed nodes are skipped; nodes behind a bypass that cannot pass
 * its input through are blocked with the reason.
 */
export function quoteRun(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeIds?: string[],
  scope: QuoteScope = nodeIds ? 'node' : 'all',
): { quoteId: string; scope: QuoteScope; items: QuoteItem[]; total: number; balanceAfter: number } {
  const ids = nodeIds && scope !== 'all' && scope !== 'node' ? [...new Set(nodeIds.flatMap((id) => runScopeNodes({ nodes, edges }, id, scope)))] : nodeIds;
  const picked = dependencyOrder(ids ? nodes.filter((n) => ids.includes(n.id)) : nodes, edges);
  const items: QuoteItem[] = picked.map((n) => {
    const model = typeof n.params.model === 'string' ? n.params.model : '';
    if (n.bypass) return { nodeId: n.id, action: 'bypassed', model, credits: 0, reason: 'Bypassed' };
    if (n.kind === 'script' || n.kind === 'text' || n.kind === 'asset') return { nodeId: n.id, action: 'none', model, credits: 0 };
    if (n.status === 'generating' || n.status === 'queued') return { nodeId: n.id, action: 'reuse', model, credits: 0, reason: 'Already running' };
    const blocked = blockedByBypass({ nodes, edges }, n.id);
    if (blocked) return { nodeId: n.id, action: 'blocked', model, credits: 0, reason: blocked.message };
    // The picked node always regenerates; elsewhere current versions are reused.
    const anchor = scope === 'node' || scope === 'from' || (nodeIds?.includes(n.id) ?? false);
    if (n.status === 'done' && !anchor) return { nodeId: n.id, action: 'reuse', model, credits: 0 };
    return { nodeId: n.id, action: 'run', model, credits: n.cost ?? (typeof n.params.runCost === 'number' ? n.params.runCost : 0) };
  });
  const total = items.reduce((s, i) => s + (i.action === 'run' ? i.credits : 0), 0);
  return { quoteId: `qt_${Date.now()}`, scope, items, total, balanceAfter: credits.get().available - total };
}

export type StartRunResult = { ok: true; runId: string } | { ok: false; code: 'INSUFFICIENT_CREDITS'; needed: number } | { ok: false; code: 'OFFLINE' };

/** `POST /api/runs { quoteId }`: holds credits and starts one job per `run` item. */
export function startRun(items: Array<{ nodeId: string; credits: number }>): StartRunResult {
  if (!room) return { ok: false, code: 'OFFLINE' };
  const r = room.startJobs(
    items.map((i) => i.nodeId),
    { costs: Object.fromEntries(items.map((i) => [i.nodeId, i.credits])) },
  );
  return r.ok ? { ok: true, runId: `run_${Date.now()}` } : r;
}

/** Top-up checkout (`POST /api/billing/topup`); the CreditAccount grant arrives as `credits.changed`. */
export async function topUp(amountUsd: number): Promise<{ credits: number }> {
  const r = await checkoutTopUp(amountUsd);
  room?.grant(r.credits);
  return { credits: r.credits };
}

/** Switches the active version of a node's result. */
export function setActiveVersion(nodeId: string, n: number): boolean {
  return room?.setVersion(nodeId, n) ?? false;
}

/* ---------- Agent (AgentSession over the project socket) ---------- */

/** Simulated agent latency, ms. */
export const MOCK_AGENT_LATENCY = 600;

/** The plan options of the current proposal; Shuffle shows the next one (free, no new turn). */
export function agentPlanOptions(): AgentPlanOption[] {
  return [MOCK_AGENT.plan, ...MOCK_AGENT_OPTIONS];
}

/** `propose.graphPatch` (harness section 3): a patch the user applies or discards. */
export interface GraphProposal {
  id: string;
  baseRevision: number;
  summary: string;
  /** One line per changed node, for the diff list. */
  changes: Array<{ nodeId: string; title: string; detail: string }>;
  ops: LocalOp[];
}

export interface AgentReply {
  text: string;
  proposal?: GraphProposal;
}

/** Request words the mock agent turns into a prompt edit and a modifier. */
const EDITS: Array<{ re: RegExp; phrase: string; modifier?: [string, string] }> = [
  { re: /warm/i, phrase: 'warmer color temperature, golden light', modifier: ['Lighting', 'Golden hour'] },
  { re: /cool|cold/i, phrase: 'cooler color temperature, blue morning light', modifier: ['Lighting', 'Overcast'] },
  { re: /slow/i, phrase: 'slower, calmer movement', modifier: ['Pace', 'Slow'] },
  { re: /fast|quick/i, phrase: 'faster cuts, energetic movement', modifier: ['Pace', 'Fast'] },
  { re: /close/i, phrase: 'tighter close-up framing', modifier: ['Framing', 'Close-up'] },
];

let proposalSeq = 0;

/**
 * Sends one message to the agent (AgentSession turn over the project socket).
 * The mock understands “shot N” plus an edit (warmer, slower, …) and answers
 * with a graph-patch proposal for that node; anything else gets a plain reply.
 */
export async function sendAgentMessage(text: string, opts: { llm: string; model: string }): Promise<AgentReply> {
  await new Promise((r) => setTimeout(r, MOCK_AGENT_LATENCY));
  void opts;
  const state = room?.state;
  const shots = (state?.nodes ?? []).filter((n) => n.kind === 'video');
  const m = /shot\s*(\d+|[a-z])\b/i.exec(text);
  const index = m ? (/^\d+$/.test(m[1]!) ? Number(m[1]) - 1 : m[1]!.toLowerCase().charCodeAt(0) - 97) : -1;
  const target = shots[index] ?? shots.find((n) => text.toLowerCase().includes(n.title.toLowerCase()));
  const edit = EDITS.find((e) => e.re.test(text));
  if (!state || !target || !edit) {
    const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    return { text: `Noted: “${short}”. Name a shot (for example “shot 2”) and what to change, and I’ll propose the edit.` };
  }
  const prompt = typeof target.params.prompt === 'string' ? target.params.prompt : '';
  const modifiers = (target.params.modifiers && typeof target.params.modifiers === 'object' ? target.params.modifiers : {}) as Record<string, string>;
  const params: Record<string, unknown> = { prompt: prompt ? `${prompt}, ${edit.phrase}` : edit.phrase };
  if (edit.modifier) params.modifiers = { ...modifiers, [edit.modifier[0]]: edit.modifier[1] };
  const detail = edit.modifier ? `Prompt: “…, ${edit.phrase}” · ${edit.modifier[0]}: ${edit.modifier[1]}` : `Prompt: “…, ${edit.phrase}”`;
  return {
    text: `Here’s the change for ${target.title}. Nothing is applied or charged until you click Apply.`,
    proposal: {
      id: `prop_mock_${++proposalSeq}`,
      baseRevision: state.revision,
      summary: `Update ${target.title}`,
      changes: [{ nodeId: target.id, title: target.title, detail }],
      ops: [{ op: 'updateNode', nodeId: target.id, params }],
    },
  };
}

/** Test helper: forget cached mock state so the next read re-applies localStorage. */
export function resetCanvasMocksForTests() {
  credits.reset();
  titles.reset();
  shares.reset();
}
