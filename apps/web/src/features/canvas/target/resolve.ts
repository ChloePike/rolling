/**
 * Where "a canvas" means a real project (pure logic, unit tested).
 *
 * The sidebar Canvas item opens, in order: the last canvas this user opened in
 * this workspace (if it still exists and is accessible), else the most recently
 * updated project, else a new blank canvas (owner decision: never a 404, never
 * a detour through Home).
 */

/** A project the user can open, shaped like a `GET /api/projects` row. */
export interface CanvasSummary {
  id: string;
  title: string;
  /** Epoch ms. */
  updatedAt: number;
}

export interface ResolveDeps {
  /** The remembered last canvas for this user and workspace. */
  lastId: string | null;
  /** Recent projects of the workspace (one cached query). */
  list: () => Promise<CanvasSummary[]>;
  /** Whether a project outside the listed page still opens (`GET /api/projects/:id`). */
  exists: (id: string) => Promise<boolean>;
  /** Forget a stale last canvas. */
  forget: (id: string) => void;
  /** Create a blank canvas and return its id; null when not allowed (viewers) or not now (preload). */
  create: (() => Promise<string>) | null;
}

export type CanvasTarget = { kind: 'open'; projectId: string; via: 'last' | 'recent' | 'created' } | { kind: 'none' };

/** The most recently updated project, or null. */
export function mostRecent(list: readonly CanvasSummary[]): CanvasSummary | null {
  let best: CanvasSummary | null = null;
  for (const p of list) if (!best || p.updatedAt > best.updatedAt) best = p;
  return best;
}

export async function resolveCanvasTarget(deps: ResolveDeps): Promise<CanvasTarget> {
  const list = await deps.list();
  if (deps.lastId) {
    if (list.some((p) => p.id === deps.lastId)) return { kind: 'open', projectId: deps.lastId, via: 'last' };
    // Not on the first page: older, deleted, or in another workspace. One check decides.
    if (await deps.exists(deps.lastId).catch(() => false)) return { kind: 'open', projectId: deps.lastId, via: 'last' };
    deps.forget(deps.lastId);
  }
  const recent = mostRecent(list);
  if (recent) return { kind: 'open', projectId: recent.id, via: 'recent' };
  if (!deps.create) return { kind: 'none' };
  return { kind: 'open', projectId: await deps.create(), via: 'created' };
}

/* ---------- One create at a time (double clicks, StrictMode, two tabs) ---------- */

const inFlight = new Map<string, Promise<string>>();

interface LockManagerLike {
  request: (name: string, cb: () => Promise<string>) => Promise<string>;
}

/**
 * Runs `create` at most once at a time per `key`: callers in this tab share the
 * pending promise; across tabs a Web Lock serializes them and `recheck` (run
 * inside the lock) returns a project another tab made meanwhile, so two tabs
 * still make one project.
 */
export function createOnce(key: string, recheck: () => Promise<string | null>, create: () => Promise<string>, locks: LockManagerLike | null = webLocks()): Promise<string> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = async () => (await recheck()) ?? (await create());
  const p = (locks ? locks.request(`rolling.canvas.create.${key}`, run) : run()).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function webLocks(): LockManagerLike | null {
  const l = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return l && typeof l.request === 'function' ? l : null;
}

/* ---------- Where an incoming item lands on the canvas ---------- */

export interface PlacedNode {
  position: { x: number; y: number };
  width?: number;
}

/** Gap between the graph and an inserted node. */
export const INSERT_GAP = 80;

/**
 * A free spot for `count` nodes: one column right of everything on the canvas,
 * level with the top of the graph (never overlapping), or `empty` when the
 * canvas has no nodes.
 */
export function freePosition(nodes: readonly PlacedNode[], nodeWidth: number, empty: { x: number; y: number }): { x: number; y: number } {
  if (!nodes.length) return { x: Math.round(empty.x), y: Math.round(empty.y) };
  let right = -Infinity;
  let top = Infinity;
  for (const n of nodes) {
    right = Math.max(right, n.position.x + (n.width ?? nodeWidth));
    top = Math.min(top, n.position.y);
  }
  return { x: Math.round(right + INSERT_GAP), y: Math.round(top) };
}
