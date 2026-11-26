/**
 * Items on their way to a canvas ("Send to canvas", "Use in canvas", "Edit in
 * canvas"). The sender stores the item under a one-time token in
 * sessionStorage and opens `/p/:projectId?insert=<token>`; the canvas takes it
 * once its graph has loaded and adds an asset node through the normal patch
 * path (so it syncs, undoes and survives a reload like any edit). A reload
 * after that finds no token and adds nothing.
 */

export type IncomingMedia = 'image' | 'video' | 'audio';

export interface IncomingItem {
  /** Display name, used as the node title. */
  name: string;
  media: IncomingMedia;
  /** Real asset id (`ast_…`), when the item is an asset the planner can read. */
  assetId?: string | null;
  /** Source id for references (asset, character, public item or run id). */
  refId: string;
  /** Where it came from (D-005 provenance on asset nodes). */
  source?: 'mine' | 'public' | 'generated' | 'character';
  /** One line of detail shown on the node. */
  label?: string;
  /** Placeholder tone (mock thumbnails). */
  tone?: string;
}

interface Stored {
  projectId: string;
  items: IncomingItem[];
  at: number;
}

const PREFIX = 'rolling.canvas.incoming.';
const MAX_AGE_MS = 10 * 60_000;

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** In-memory fallback when sessionStorage is blocked (the hand-off is same-tab). */
const memory = new Map<string, string>();

/** Keeps `items` for `projectId` and returns the token for `?insert=`. */
export function saveIncoming(projectId: string, items: IncomingItem[]): string {
  const token = Math.random().toString(36).slice(2, 10);
  const raw = JSON.stringify({ projectId, items, at: Date.now() } satisfies Stored);
  try {
    const s = store();
    if (s) s.setItem(PREFIX + token, raw);
    else memory.set(token, raw);
  } catch {
    memory.set(token, raw);
  }
  return token;
}

/** Takes (and clears) the items behind `token` when they are for `projectId`. */
export function takeIncoming(token: string, projectId: string): IncomingItem[] | null {
  let raw: string | null = memory.get(token) ?? null;
  memory.delete(token);
  try {
    const s = store();
    raw ??= s?.getItem(PREFIX + token) ?? null;
    s?.removeItem(PREFIX + token);
  } catch {
    /* Storage unavailable. */
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Stored;
    if (p.projectId !== projectId || Date.now() - p.at > MAX_AGE_MS || !Array.isArray(p.items)) return null;
    return p.items;
  } catch {
    return null;
  }
}

/** Asset node params for an incoming item (the same shape the canvas's own asset picker adds). */
export function incomingParams(it: IncomingItem): Record<string, unknown> {
  return {
    media: it.media,
    label: it.label ?? '',
    tone: it.tone ?? 'var(--c-tone-indigo)',
    refId: it.refId,
    ...(it.assetId ? { assetId: it.assetId } : {}),
    ...(it.source ? { source: it.source === 'mine' ? 'upload' : it.source } : {}),
  };
}
