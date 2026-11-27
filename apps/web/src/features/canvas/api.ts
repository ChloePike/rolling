import { useEffect, useSyncExternalStore } from 'react';
import { getPrefs } from '@/lib/prefs';
import { checkoutTopUp, getCredits as getSessionCredits } from '@/lib/session';
import { apiFetch, ApiError, isApiError, isMockApi, openProjectChannel } from '@/features/overlays/backend';
import { applyProposal, discardProposal, sendTurn, threadFor, type ApplyResult, type Proposal } from '@/features/overlays/agent';
import { listRuns } from '@/features/overlays/runs';
import type { MockProjectRoom } from './graph/mockRoom';
import { GraphStore } from './graph/store';
import { ProjectSync, type SyncEvents } from './graph/sync';
import { blockedByBypass, runScopeNodes, type GraphEdge, type GraphNode, type LocalOp, type RunScope } from '@rolling/core/graph';
import { mockProjectOpens } from './target/projects';
import type { AgentPlanOption } from './mocks';
import { mockData } from '@/lib/api/mode';

/**
 * The canvas talks to the backend only through this file.
 *
 * Real mode (default): the ProjectRoom WebSocket (`/api/projects/:id/ws`:
 * hello, snapshot, patch → ack | conflict | error, graph.patched,
 * node.version with `statuses`, job.*, credits.changed, agent/proposal
 * events) plus REST for the project (`GET/PATCH /api/projects/:id`), versions
 * (`/api/nodes/:id/versions`, `/active`), sharing and runs
 * (`POST /api/runs/quote`, `POST /api/runs`).
 *
 * Mock mode (`VITE_API_MODE=mock`, the fidelity and interaction specs): an
 * in-browser ProjectRoom that speaks the same envelope protocol. Mock flags
 * (`?mock=`): `frozen` (jobs never advance), `fast` (no latency, quick
 * ticks), `fail` (every new job fails at 40% and refunds).
 */

/** Why a canvas cannot open or stay open (socket close codes 4401/4403/4404/4410, or the REST check). */
export type ProjectFatal = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'PROJECT_DELETED';

export interface ProjectEvents extends SyncEvents {
  onFatal?: (reason: ProjectFatal) => void;
}

export interface ProjectSession {
  projectId: string;
  store: GraphStore;
  sync: ProjectSync;
  /** Canvas id of the project's (only) canvas, `cnv_<project ULID>` (real mode; from the snapshot). */
  canvasId: () => string | null;
  /** Raw envelope to the room (real mode: e.g. `timeline.patch`). */
  send?: (raw: string) => void;
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
  return { frozen: mock === 'frozen', fast: mock === 'fast', fail: mock === 'fail', empty: mock === 'empty' };
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

/** `credits.changed { balance, held, plan?, purchased? }` from the room: spends plan credits first, refunds go back to the plan. */
function applyCredits(balance: number, held: number, extra?: { plan?: number; purchased?: number }) {
  const c = credits.get();
  if (extra && typeof extra.plan === 'number' && typeof extra.purchased === 'number') {
    const settled = -(balance - c.available + (held - c.held));
    credits.set({ ...c, available: balance, held, plan: extra.plan, purchased: extra.purchased, usedThisMonth: c.usedThisMonth + Math.max(0, settled) });
    return;
  }
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

/** The quote's `balance` is the CreditAccount's: keep the canvas header in step with it. */
function seedBalance(balance: number) {
  const c = credits.get();
  if (c.available !== balance) applyCredits(balance, c.held);
}

export function useCredits(): CanvasCredits {
  return useSyncExternalStore(credits.subscribe, credits.get, credits.get);
}

/* ---------- Project session ---------- */

let room: MockProjectRoom | null = null;

const FATAL_CLOSE: Record<number, ProjectFatal> = { 4401: 'UNAUTHENTICATED', 4403: 'FORBIDDEN', 4404: 'NOT_FOUND', 4410: 'PROJECT_DELETED' };

function fatalFor(e: unknown): ProjectFatal | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return 'UNAUTHENTICATED';
  if (e.status === 403) return 'FORBIDDEN';
  if (e.status === 404) return 'NOT_FOUND';
  return null;
}

/* ---------- Project socket fan-out for other layers (editor timeline, agent) ---------- */

type ProjectMessage = { type: string; id: string; payload: unknown };
const projectListeners = new Map<string, Set<(msg: ProjectMessage) => void>>();
const openSessions = new Map<string, ProjectSession>();

/** Messages of the open project's socket the canvas does not handle (`timeline.patched`, `agent.*`, `proposal.*`). */
export function subscribeProjectMessages(projectId: string, listener: (msg: ProjectMessage) => void): () => void {
  let set = projectListeners.get(projectId);
  if (!set) projectListeners.set(projectId, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

function emitProjectMessage(projectId: string, msg: ProjectMessage) {
  for (const l of projectListeners.get(projectId) ?? []) l(msg);
}

/** The open canvas session of a project (the editor sends `timeline.patch` through it). */
export function openSession(projectId: string): ProjectSession | undefined {
  return openSessions.get(projectId);
}

function openRealProject(projectId: string, events: ProjectEvents): ProjectSession {
  const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
  // D-014: a channel of the shared realtime connection (lib/realtime), not a socket of our own.
  const channel = openProjectChannel(projectId);
  let canvasId: string | null = null;
  let fatal = false;
  const fail = (reason: ProjectFatal) => {
    if (fatal) return;
    fatal = true;
    channel.unsubscribe();
    events.onFatal?.(reason);
  };
  const sync = new ProjectSync(store, { send: (raw) => channel.send(raw), onMessage: (l) => channel.onMessage(l), close: () => channel.unsubscribe() }, {
    ...events,
    onCredits: (balance, held, extra) => {
      applyCredits(balance, held, extra);
      events.onCredits?.(balance, held, extra);
    },
    onMessage: (msg) => {
      if (msg.type === 'error' && (msg.payload as { code?: string })?.code === 'PROJECT_DELETED') fail('PROJECT_DELETED');
      emitProjectMessage(projectId, msg);
      events.onMessage?.(msg);
    },
  });
  const offSnapshot = channel.onMessage((raw) => {
    if (!raw.startsWith('{"type":"snapshot"')) return;
    try {
      const snap = (JSON.parse(raw) as { payload: { canvases?: Array<{ id: string }>; title?: string } }).payload;
      canvasId = snap.canvases?.[0]?.id ?? canvasId;
      if (snap.title) setTitle(projectId, snap.title);
    } catch {
      /* Not JSON: ignored. */
    }
  });
  const offStatus = channel.onStatus((st) => {
    if (st.fatalCode && FATAL_CLOSE[st.fatalCode]) return fail(FATAL_CLOSE[st.fatalCode]!);
    sync.setConnected(st.open);
  });
  // Project metadata (title, role) for the top bar; also the definitive 404 check.
  void loadProjectMeta(projectId).then(
    (meta) => {
      // Viewers get a read-only canvas (also from `hello.canEdit` when the channel forwards it).
      if (!meta.canEdit) sync.canEdit = false;
    },
    (e: unknown) => {
      const f = fatalFor(e);
      if (f) fail(f);
    },
  );
  const session: ProjectSession = {
    projectId,
    store,
    sync,
    canvasId: () => canvasId,
    send: (raw) => channel.send(raw),
    dispose: () => {
      offSnapshot();
      offStatus();
      sync.dispose();
      if (openSessions.get(projectId) === session) openSessions.delete(projectId);
    },
  };
  openSessions.set(projectId, session);
  return session;
}

export function openProject(projectId: string, events: ProjectEvents): ProjectSession {
  if (!isMockApi()) return openRealProject(projectId, events);
  if (!mockProjectOpens(projectId)) {
    // Mock 404 (missing, deleted or another workspace's project): the same fatal path as the real check.
    const store = new GraphStore({ revision: 0, nodes: [], edges: [], groups: [] });
    const sync = new ProjectSync(store, { send: () => {}, onMessage: () => () => {}, close: () => {} }, events);
    const t = setTimeout(() => events.onFatal?.('NOT_FOUND'), 0);
    return { projectId, store, sync, canvasId: () => null, dispose: () => (clearTimeout(t), sync.dispose()) };
  }
  const flags = mockFlags();
  room?.dispose();
  const c = credits.get();
  room = new (mockData().room.MockProjectRoom)({
    projectId,
    // `?mock=empty`: a canvas with no nodes yet (the empty state).
    initial: flags.empty ? { revision: 1, nodes: [], edges: [], groups: [] } : mockData().canvas.mockGraph(),
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
    projectId,
    store,
    sync,
    canvasId: () => `cnv_${projectId.replace(/^prj_/, '')}`,
    dispose: () => sync.dispose(),
  };
}

/* ---------- Project title (`PATCH /api/projects/:id { title }`) ---------- */

const titleKey = (id: string) => `rolling.canvas.title.${id}`;
const titles = observable<Record<string, string>>(() => ({}));

function setTitle(projectId: string, title: string) {
  if (titles.get()[projectId] !== title) titles.set({ ...titles.get(), [projectId]: title });
}

/** `GET /api/projects/:id` → `{ project, role, canEdit, snapshot }`; keeps the title. */
async function loadProjectMeta(projectId: string): Promise<{ title: string; canEdit: boolean; role: string }> {
  const r = await apiFetch<{ project: { title: string }; role: string; canEdit: boolean }>(`/projects/${encodeURIComponent(projectId)}`);
  setTitle(projectId, r.project.title);
  return { title: r.project.title, canEdit: r.canEdit, role: r.role };
}

export function getProject(projectId: string) {
  if (!isMockApi()) return { id: projectId, title: titles.get()[projectId] ?? '' };
  const saved = titles.get()[projectId] ?? read<string>(titleKey(projectId));
  const MOCK_PROJECT = mockData().canvas.MOCK_PROJECT;
  return { ...MOCK_PROJECT, id: projectId, title: saved ?? MOCK_PROJECT.title };
}

export function useProject(projectId: string) {
  useSyncExternalStore(titles.subscribe, titles.get, titles.get);
  return getProject(projectId);
}

export async function renameProject(projectId: string, title: string): Promise<{ ok: true; title: string } | { ok: false; code: 'EMPTY_TITLE' }> {
  const t = title.trim().slice(0, 120);
  if (!t) return { ok: false, code: 'EMPTY_TITLE' };
  if (!isMockApi()) {
    const r = await apiFetch<{ project: { title: string } }>(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { title: t } });
    setTitle(projectId, r.project.title);
    return { ok: true, title: r.project.title };
  }
  write(titleKey(projectId), t);
  titles.set({ ...titles.get(), [projectId]: t });
  return { ok: true, title: t };
}

/* ---------- Share (`/api/projects/:id/share`) ---------- */

export type ShareAudience = 'link' | 'workspace';

export interface ShareSettings {
  /** False when nothing is shared: never published, or after "Stop sharing" (see `revoked`). */
  active: boolean;
  /** Not active because a link was stopped (the old URL no longer opens); false when the canvas was never shared. */
  revoked?: boolean;
  url: string;
  snapshotAt: Date;
  audience: ShareAudience;
  allowDownloads: boolean;
  showPrompt: boolean;
  /** "Publish to profile" (real API only; the dialog shows the row when set). */
  showOnProfile?: boolean;
}

export type SharePatch = Partial<Pick<ShareSettings, 'audience' | 'allowDownloads' | 'showPrompt' | 'showOnProfile'>>;

const shareKey = (id: string) => `rolling.canvas.share.${id}`;
type StoredShare = Omit<ShareSettings, 'snapshotAt'> & { snapshotAt: string };
const shares = observable<Record<string, ShareSettings>>(() => ({}));
const shareLoads = new Map<string, Promise<void>>();

function defaultShare(): ShareSettings {
  // Real mode: nothing is shared until the first publish; `GET /api/projects/:id/share` replaces this on open.
  if (!isMockApi()) return { active: false, revoked: false, url: '', snapshotAt: new Date(), audience: 'link', allowDownloads: false, showPrompt: true, showOnProfile: false };
  const MOCK_SHARE = mockData().canvas.MOCK_SHARE;
  return { active: true, url: MOCK_SHARE.url, snapshotAt: MOCK_SHARE.snapshotAt, audience: 'link', allowDownloads: false, showPrompt: true };
}

interface ShareSettingsWire {
  audience: ShareAudience;
  allowDownload: boolean;
  showPrompt: boolean;
  showOnProfile: boolean;
}

/** `GET` and `PATCH /api/projects/:id/share` answer this; `POST` answers `{ shareId, url, createdAt, ...settings }`. */
interface ShareStateWire extends ShareSettingsWire {
  enabled: boolean;
  /** A stopped link exists (absent on older servers). */
  revoked?: boolean;
  url: string | null;
  snapshotAt: number | null;
}

function fromWire(cur: ShareSettings, w: ShareSettingsWire & { url: string | null; at: number | null; active: boolean; revoked?: boolean }): ShareSettings {
  return {
    ...cur,
    active: w.active,
    revoked: !w.active && w.revoked === true,
    url: w.active && w.url ? w.url.replace(/^https?:\/\//, '') : cur.url,
    snapshotAt: w.at ? new Date(w.at) : cur.snapshotAt,
    audience: w.audience,
    allowDownloads: w.allowDownload,
    showPrompt: w.showPrompt,
    showOnProfile: w.showOnProfile,
  };
}

function toWire(p: SharePatch): Partial<ShareSettingsWire> {
  return {
    ...(p.audience !== undefined ? { audience: p.audience } : {}),
    ...(p.allowDownloads !== undefined ? { allowDownload: p.allowDownloads } : {}),
    ...(p.showPrompt !== undefined ? { showPrompt: p.showPrompt } : {}),
    ...(p.showOnProfile !== undefined ? { showOnProfile: p.showOnProfile } : {}),
  };
}

/** `POST /api/projects/:id/share` with every setting: (re)writes the snapshot; the link stays the same. */
async function postShare(projectId: string, cur: ShareSettings): Promise<ShareSettings> {
  const r = await apiFetch<ShareSettingsWire & { shareId: string; url: string; createdAt: number }>(`/projects/${encodeURIComponent(projectId)}/share`, {
    method: 'POST',
    body: toWire(cur),
  });
  return saveShare(projectId, fromWire(cur, { ...r, at: r.createdAt || Date.now(), active: true }));
}

/** Reads the server's share state (real API), so the dialog shows it after a reload too. */
export function loadShare(projectId: string): Promise<void> {
  if (isMockApi()) return Promise.resolve();
  let p = shareLoads.get(projectId);
  if (!p) {
    p = apiFetch<ShareStateWire>(`/projects/${encodeURIComponent(projectId)}/share`)
      .then((r) => {
        saveShare(projectId, fromWire(getShare(projectId), { ...r, at: r.snapshotAt, active: r.enabled }));
      })
      .catch(() => {
        // Keep the last known state; the next open retries.
        shareLoads.delete(projectId);
      });
    shareLoads.set(projectId, p);
  }
  return p;
}

export function getShare(projectId: string): ShareSettings {
  const cached = shares.get()[projectId];
  if (cached) return cached;
  const stored = read<StoredShare>(shareKey(projectId));
  return stored ? { ...defaultShare(), ...stored, snapshotAt: new Date(stored.snapshotAt) } : defaultShare();
}

export function useShare(projectId: string): ShareSettings {
  useSyncExternalStore(shares.subscribe, shares.get, shares.get);
  useEffect(() => {
    void loadShare(projectId);
  }, [projectId]);
  return getShare(projectId);
}

function saveShare(projectId: string, next: ShareSettings): ShareSettings {
  write(shareKey(projectId), { ...next, snapshotAt: next.snapshotAt.toISOString() });
  shares.set({ ...shares.get(), [projectId]: next });
  return next;
}

/**
 * Share settings. Real API: `PATCH /api/projects/:id/share` changes them on the
 * active link without re-publishing (the server enforces the audience; prompts
 * are hidden at once and shown again from the next publish). With sharing off
 * they are kept and sent with the next publish.
 */
export async function updateShare(projectId: string, patch: SharePatch): Promise<ShareSettings> {
  const cur = getShare(projectId);
  const next = { ...cur, ...patch };
  if (isMockApi() || !cur.active) return saveShare(projectId, next);
  saveShare(projectId, next);
  try {
    const r = await apiFetch<ShareStateWire>(`/projects/${encodeURIComponent(projectId)}/share`, { method: 'PATCH', body: toWire(patch) });
    return saveShare(projectId, fromWire(next, { ...r, at: r.snapshotAt, active: r.enabled }));
  } catch {
    // Refused (role, network): the toggle visibly snaps back.
    return saveShare(projectId, cur);
  }
}

/** `DELETE /api/projects/:id/share`: the link stops working. */
export async function stopSharing(projectId: string): Promise<ShareSettings> {
  if (!isMockApi()) await apiFetch(`/projects/${encodeURIComponent(projectId)}/share`, { method: 'DELETE' });
  return saveShare(projectId, { ...getShare(projectId), active: false, revoked: true });
}

/** `POST /api/projects/:id/share`: a new snapshot (and a link again after stopping), with the current settings. */
export async function publishShare(projectId: string): Promise<ShareSettings> {
  const cur = getShare(projectId);
  if (!isMockApi()) return postShare(projectId, cur);
  const url = cur.active ? cur.url : `${mockData().canvas.MOCK_SHARE.url.replace(/\/s\/.*/, '')}/s/${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`;
  return saveShare(projectId, { ...cur, active: true, revoked: false, url, snapshotAt: new Date() });
}

/* ---------- Runs ---------- */

export type QuoteAction = 'run' | 'reuse' | 'blocked' | 'bypassed' | 'none';

/** Quote item codes (docs/api.md → Runs, Safety). The UI maps them to copy; `reason` is the English fallback. */
export type QuoteCode =
  | 'missing_input'
  | 'upstream_blocked'
  | 'bypassed_input'
  | 'unknown_model'
  | 'no_capable_model'
  | 'unsupported'
  | 'unpriced'
  | 'resolution_locked'
  | 'mature_not_allowed'
  | 'identity_requires_platform_assets'
  | 'empty_prompt'
  | 'SAFETY_BLOCKED'
  | 'MATURE_REQUIRED'
  | 'SAFETY_REVIEW'
  | 'NO_PLAN';

export interface QuoteItem {
  nodeId: string;
  action: QuoteAction;
  /** Gateway id (real) or the node's model param (mock). */
  model: string;
  /** Display name from the quote (Auto resolved, D-009). */
  modelName?: string | null;
  credits: number;
  reason?: string;
  code?: QuoteCode;
  /** `resolution_locked`: the plan that unlocks it. */
  lowestPlan?: 'starter' | 'plus' | 'pro' | null;
  /** `MATURE_REQUIRED`: why the caller has no mature access (D-005); picks the copy. */
  matureAccess?: 'no_plan' | 'preference_off' | 'workspace_off';
  dependsOn?: string[];
  /** D-020: the price includes prompt enhancement. */
  promptExpand?: true;
}

/** `node`, `upTo`, `from`, `all` (`@rolling/core/graph` RunScope) plus `selection` (the given nodes). */
export type QuoteScope = RunScope | 'selection';

export interface QuoteRequest {
  scope: QuoteScope;
  nodeIds?: string[];
}

export interface Quote {
  /** Null when nothing runs (only reuse / blocked / none rows): nothing to confirm. */
  quoteId: string | null;
  scope: QuoteScope;
  items: QuoteItem[];
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number | null;
  confirmThreshold: number;
  /** total ≥ the user's “Confirm before running” threshold (D-006) → RunConfirm; else start at once. */
  needsConfirm: boolean;
}

interface QuoteResponse {
  quoteId: string | null;
  items: Array<{
    ref: string;
    nodeId: string | null;
    title: string;
    kind: string;
    action: QuoteAction;
    model: string | null;
    modelName: string | null;
    credits: number;
    code?: QuoteCode;
    reason?: string;
    lowestPlan?: 'starter' | 'plus' | 'pro' | null;
    matureAccess?: 'no_plan' | 'preference_off' | 'workspace_off';
    dependsOn: string[];
    promptExpand?: true;
  }>;
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number | null;
  confirmThreshold: number;
  needsConfirm: boolean;
}

/**
 * `POST /api/runs/quote { projectId, scope, nodeIds? }` (real) or the local
 * planner over the store's graph (mock). `node`, `upTo` and `from` take
 * exactly one node id; `selection` one or more; `all` none.
 */
export async function requestQuote(projectId: string, req: QuoteRequest, local: { nodes: GraphNode[]; edges: GraphEdge[] }, signal?: AbortSignal): Promise<Quote> {
  if (isMockApi()) {
    const q = quoteRun(local.nodes, local.edges, req.scope === 'all' ? undefined : req.nodeIds, req.scope);
    const threshold = getPrefs().confirmThreshold;
    const balance = credits.get().available;
    return { ...q, quoteId: q.total > 0 ? q.quoteId : null, balance, expiresAt: Date.now() + 600_000, confirmThreshold: threshold, needsConfirm: threshold <= 0 || q.total >= threshold };
  }
  const body: Record<string, unknown> = { projectId, scope: req.scope };
  if (req.scope !== 'all') body.nodeIds = req.nodeIds;
  const r = await apiFetch<QuoteResponse>('/runs/quote', { method: 'POST', body, signal });
  seedBalance(r.balance);
  return {
    quoteId: r.quoteId,
    scope: req.scope,
    items: r.items.map((i) => ({
      nodeId: i.nodeId ?? i.ref,
      action: i.action,
      model: i.model ?? '',
      modelName: i.modelName,
      credits: i.credits,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.code ? { code: i.code } : {}),
      ...(i.lowestPlan !== undefined ? { lowestPlan: i.lowestPlan } : {}),
      ...(i.matureAccess ? { matureAccess: i.matureAccess } : {}),
      dependsOn: i.dependsOn,
      // D-020: the row says "Includes prompt enhancement" when the price includes it.
      ...(i.promptExpand ? { promptExpand: true as const } : {}),
    })),
    total: r.total,
    balance: r.balance,
    balanceAfter: r.balanceAfter,
    expiresAt: r.expiresAt,
    confirmThreshold: r.confirmThreshold,
    needsConfirm: r.needsConfirm,
  };
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

/**
 * Local run planner (mock mode and tests), shaped like `POST /api/runs/quote`. Scopes: `all` (the whole
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
  const ids = nodeIds && scope !== 'all' && scope !== 'node' && scope !== 'selection' ? [...new Set(nodeIds.flatMap((id) => runScopeNodes({ nodes, edges }, id, scope)))] : nodeIds;
  const picked = dependencyOrder(ids ? nodes.filter((n) => ids.includes(n.id)) : nodes, edges);
  const items: QuoteItem[] = picked.map((n) => {
    const model = typeof n.params.model === 'string' ? n.params.model : '';
    if (n.bypass) return { nodeId: n.id, action: 'bypassed', model, credits: 0, reason: 'Bypassed' };
    if (n.kind === 'script' || n.kind === 'text' || n.kind === 'asset') return { nodeId: n.id, action: 'none', model, credits: 0 };
    if (n.status === 'generating' || n.status === 'queued') return { nodeId: n.id, action: 'reuse', model, credits: 0, reason: 'Already running' };
    const blocked = blockedByBypass({ nodes, edges }, n.id);
    if (blocked) return { nodeId: n.id, action: 'blocked', model, credits: 0, reason: blocked.message };
    // The picked node always regenerates; elsewhere current versions are reused.
    const anchor = scope === 'node' || scope === 'from' || scope === 'selection' || (nodeIds?.includes(n.id) ?? false);
    if (n.status === 'done' && !anchor) return { nodeId: n.id, action: 'reuse', model, credits: 0 };
    return { nodeId: n.id, action: 'run', model, credits: n.cost ?? (typeof n.params.runCost === 'number' ? n.params.runCost : 0) };
  });
  const total = items.reduce((s, i) => s + (i.action === 'run' ? i.credits : 0), 0);
  return { quoteId: `qt_${Date.now()}`, scope, items, total, balanceAfter: credits.get().available - total };
}

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; code: 'NO_PLAN' }
  | { ok: false; code: 'INSUFFICIENT_CREDITS'; needed: number; balance?: number }
  | { ok: false; code: 'QUOTE_EXPIRED' }
  | { ok: false; code: 'MEMBER_LIMIT_REACHED'; limit?: number; used?: number }
  | { ok: false; code: 'CONCURRENCY_LIMIT'; limit?: number; active?: number }
  | { ok: false; code: 'NOTHING_TO_RUN' }
  | { ok: false; code: 'OFFLINE' }
  | { ok: false; code: 'ERROR'; message: string };

/**
 * Staging / development only: `?forceFailure=1` on the canvas URL makes every
 * run item fail without calling the provider (the API ignores it in
 * production) — the refund path of canvas-flow step 7.
 */
function forceFailure(): true | undefined {
  if (typeof location === 'undefined') return undefined;
  return new URLSearchParams(location.search).get('forceFailure') === '1' ? true : undefined;
}

/** `POST /api/runs { quoteId }`: holds credits and starts one job per `run` item. */
export async function startRun(quote: Quote): Promise<StartRunResult> {
  const items = quote.items.filter((i) => i.action === 'run');
  if (isMockApi()) {
    if (!room) return { ok: false, code: 'OFFLINE' };
    const r = room.startJobs(
      items.map((i) => i.nodeId),
      { costs: Object.fromEntries(items.map((i) => [i.nodeId, i.credits])) },
    );
    return r.ok ? { ok: true, runId: `run_${Date.now()}` } : r;
  }
  if (!quote.quoteId) return { ok: false, code: 'NOTHING_TO_RUN' };
  try {
    const ff = forceFailure();
    const r = await apiFetch<{ runId: string; status: string }>('/runs', { method: 'POST', body: { quoteId: quote.quoteId, ...(ff ? { options: { forceFailure: ff } } : {}) } });
    return { ok: true, runId: r.runId };
  } catch (e) {
    return runError(e);
  }
}

/** Maps a `POST /api/runs` error to the result the UI gates on (paywalls, re-quote, messages). */
export function runError(e: unknown): Exclude<StartRunResult, { ok: true }> {
  if (!(e instanceof ApiError)) return { ok: false, code: 'ERROR', message: String(e) };
  const d = e.data as Record<string, number | undefined>;
  switch (e.code) {
    case 'NO_PLAN':
      return { ok: false, code: 'NO_PLAN' };
    case 'INSUFFICIENT_CREDITS':
      return { ok: false, code: 'INSUFFICIENT_CREDITS', needed: Number(d.needed ?? 0), balance: d.balance };
    case 'QUOTE_EXPIRED':
      return { ok: false, code: 'QUOTE_EXPIRED' };
    case 'MEMBER_LIMIT_REACHED':
      return { ok: false, code: 'MEMBER_LIMIT_REACHED', limit: d.limit, used: d.used };
    case 'CONCURRENCY_LIMIT':
      return { ok: false, code: 'CONCURRENCY_LIMIT', limit: d.limit, active: d.active };
    case 'CONFLICT':
      return { ok: false, code: 'NOTHING_TO_RUN' };
    case 'NETWORK':
      return { ok: false, code: 'OFFLINE' };
    default:
      return { ok: false, code: 'ERROR', message: e.message };
  }
}

/** Top-up checkout (`POST /api/billing/topup`); the CreditAccount grant arrives as `credits.changed`. */
export async function topUp(amountUsd: number): Promise<{ credits: number }> {
  const r = await checkoutTopUp(amountUsd);
  room?.grant(r.credits);
  return { credits: r.credits };
}

export interface NodeVersionView {
  id: string;
  n: number;
  assetId: string | null;
  active: boolean;
  stale: boolean;
  mature: boolean;
  url: string | null;
  thumbUrl: string | null;
  model?: string | null;
  createdAt: number;
  /** The job's output record; `expandedPrompt` (D-020) is the prompt that rendered when the gateway rewrote it. */
  output?: { expandedPrompt?: string } | null;
}

/** `GET /api/nodes/:id/versions?projectId=` (newest first). Mock mode: none (the room only knows n/total). */
export async function listVersions(projectId: string, nodeId: string): Promise<NodeVersionView[]> {
  if (isMockApi()) return [];
  const r = await apiFetch<{ versions: NodeVersionView[] }>(`/nodes/${encodeURIComponent(nodeId)}/versions`, { query: { projectId } });
  return r.versions;
}

/** Switches the active version of a node's result (`POST /api/nodes/:id/active`; broadcasts `node.version`). */
export async function setActiveVersion(projectId: string, nodeId: string, n: number): Promise<boolean> {
  if (isMockApi()) return room?.setVersion(nodeId, n) ?? false;
  const versions = await listVersions(projectId, nodeId);
  const v = versions.find((x) => x.n === n);
  if (!v) return false;
  try {
    await apiFetch(`/nodes/${encodeURIComponent(nodeId)}/active`, { method: 'POST', body: { projectId, versionId: v.id } });
    return true;
  } catch (e) {
    if (isApiError(e)) return false;
    throw e;
  }
}

/* ---------- Agent (AgentSession over the project socket) ---------- */

/** Simulated agent latency, ms. */
export const MOCK_AGENT_LATENCY = 600;

/** The plan options of the current proposal; Shuffle shows the next one (free, no new turn). */
export function agentPlanOptions(): AgentPlanOption[] {
  const m = mockData().canvas;
  return [m.MOCK_AGENT.plan, ...m.MOCK_AGENT_OPTIONS];
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
  /** A plan proposal (2–3 options): Build on canvas applies the picked option. */
  plan?: { proposalId: string; options: AgentPlanOption[] };
  /** Turn end reason (`safety_blocked` shows the neutral message as the reply). */
  reason?: string;
}

export interface AgentSendOptions {
  llm: string;
  model: string;
  /** Real mode: the canvas thread of this project. */
  projectId?: string;
  /** Selected node ids (the agent edits these first). */
  selection?: string[];
  /** Asset ids of `@` references. */
  refs?: string[];
  /** Current nodes, to describe a graph patch's changes by title. */
  nodes?: GraphNode[];
  onDelta?: (delta: string) => void;
}

const SHOT_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

/** API plan options → the plan card's shape. */
export function planOptionsFrom(proposal: Proposal): AgentPlanOption[] {
  if (proposal.body.kind !== 'plan') return [];
  return proposal.body.options.map((o, i) => ({
    id: `${proposal.id}:${i}`,
    title: o.title,
    estimate: o.estimate.credits,
    shots: o.shots.map((sh, j) => ({ n: sh.n, title: sh.title, seconds: sh.seconds, visual: sh.visual, tone: SHOT_TONES[j % SHOT_TONES.length]! })),
  }));
}

function describeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => (k === 'prompt' && typeof v === 'string' ? `Prompt: “${v.length > 80 ? `…${v.slice(-77)}` : v}”` : `${k}: ${typeof v === 'string' || typeof v === 'number' ? v : v === null ? '—' : JSON.stringify(v)}`))
    .join(' · ');
}

/** A `graphPatch` proposal as the panel shows it: one change line per touched node. */
export function graphProposalFrom(proposal: Proposal, nodes: GraphNode[] = []): GraphProposal | null {
  if (proposal.body.kind !== 'graphPatch') return null;
  const ops = proposal.body.ops as LocalOp[];
  const title = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;
  const changes: GraphProposal['changes'] = [];
  for (const op of ops) {
    if (op.op === 'updateNode') changes.push({ nodeId: op.nodeId, title: op.title ?? title(op.nodeId), detail: describeParams(op.params) });
    else if (op.op === 'addNode') changes.push({ nodeId: op.tempId, title: op.title, detail: `New ${op.kind} node` });
    else if (op.op === 'removeNode') changes.push({ nodeId: op.nodeId, title: title(op.nodeId), detail: 'Removed' });
  }
  return { id: proposal.id, baseRevision: proposal.baseRevision ?? 0, summary: proposal.summary, changes, ops };
}

/**
 * Real-mode agent turn on the project's canvas thread. Throws `ApiError`
 * (`NO_PLAN`, `AGENT_ALLOWANCE_EXHAUSTED`, `RATE_LIMITED`, `CONFLICT`); map it with `agentFailure`.
 */
async function sendRealAgentMessage(text: string, opts: AgentSendOptions): Promise<AgentReply> {
  const projectId = opts.projectId!;
  const thread = await threadFor(`canvas:${projectId}`, { surface: 'canvas', projectId });
  const r = await sendTurn(
    thread.id,
    { text, selection: opts.selection, refs: opts.refs, llm: opts.llm === 'default' ? null : opts.llm },
    { onDelta: opts.onDelta },
    // Canvas threads stream on the project channel (D-014).
    (l) => subscribeProjectMessages(projectId, l),
  );
  const reply: AgentReply = { text: r.text || r.error?.message || '', reason: r.reason };
  if (r.proposal?.body.kind === 'graphPatch') reply.proposal = graphProposalFrom(r.proposal, opts.nodes) ?? undefined;
  if (r.proposal?.body.kind === 'plan') reply.plan = { proposalId: r.proposal.id, options: planOptionsFrom(r.proposal) };
  return reply;
}

/** Applies an agent proposal as the user (`POST /api/agent/proposals/:id/apply`); the patch arrives as `graph.patched`. */
export async function applyAgentProposal(proposalId: string, optionIndex?: number): Promise<ApplyResult> {
  return applyProposal(proposalId, optionIndex === undefined ? {} : { optionIndex });
}

export async function discardAgentProposal(proposalId: string): Promise<void> {
  if (!isMockApi()) await discardProposal(proposalId);
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
export async function sendAgentMessage(text: string, opts: AgentSendOptions): Promise<AgentReply> {
  if (!isMockApi() && opts.projectId) return sendRealAgentMessage(text, opts);
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

/* ---------- Run history drawer (`GET /api/runs?projectId=`) ---------- */

export interface ProjectRunRow {
  id: string;
  nodeId?: string;
  title: string;
  model: string;
  credits: number;
  status: 'running' | 'done' | 'failed';
  progress?: number;
  refunded?: number;
  at: Date;
}

/** One row per run item of this project, newest first (real mode). */
export async function fetchProjectRuns(projectId: string): Promise<ProjectRunRow[]> {
  if (isMockApi()) return [];
  const page = await listRuns({ projectId, first: 30 });
  return page.runs.flatMap((r) =>
    r.items.map((it) => ({
      id: `${r.id}:${it.ref}`,
      nodeId: it.nodeId ?? undefined,
      title: it.title ?? r.name,
      model: it.modelName || it.model,
      credits: it.status === 'succeeded' ? (it.spent ?? it.credits) : it.credits,
      status: it.status === 'succeeded' || it.status === 'skipped' ? ('done' as const) : it.status === 'failed' || it.status === 'canceled' ? ('failed' as const) : ('running' as const),
      ...(it.progress !== null ? { progress: it.progress } : {}),
      ...(it.refunded ? { refunded: it.refunded } : {}),
      at: new Date(r.createdAt),
    })),
  );
}
