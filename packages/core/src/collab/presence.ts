import { z } from 'zod';

/**
 * Canvas presence (D-031). Who is on a project, where their pointer is and
 * what they have selected. Presence travels over the global socket (D-014):
 * the client sends `presence` to its UserHub, the hub forwards it to the
 * ProjectRoom, and the room fans `presence.updated` / `presence.left` out to
 * the other subscribers. The room keeps presence in memory per connection
 * only: never in SQLite, never in the event ring, never replayed.
 */

/** The client sends at most one cursor update per this many ms (trailing update kept). */
export const PRESENCE_CLIENT_THROTTLE_MS = 50;
/** The room forwards at most one update per entry per this many ms (the latest wins). */
export const PRESENCE_SERVER_MIN_INTERVAL_MS = 40;
/** Clients repeat their presence this often while the canvas is open. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** Entries not refreshed for this long are dropped (`presence.left`). */
export const PRESENCE_TTL_MS = 45_000;
/** Most node ids one selection can carry. */
export const PRESENCE_MAX_SELECTION = 50;

const ProjectId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Coord = z.number().finite().min(-1e7).max(1e7);

export const PresenceCursor = z.object({ x: Coord, y: Coord });
export type PresenceCursor = z.infer<typeof PresenceCursor>;

/** Client -> gateway `presence`: cursor in canvas (flow) coordinates, selected node ids. */
export const PresencePayload = z.object({
  projectId: ProjectId,
  /** Tab key: several tabs share one browser socket, each has its own cursor. */
  key: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).default('tab'),
  cursor: PresenceCursor.nullable().optional(),
  selection: z.array(z.string().min(1).max(64)).max(PRESENCE_MAX_SELECTION).optional(),
});
export type PresencePayload = z.infer<typeof PresencePayload>;

/** Client -> gateway `presence.leave` (tab closed the canvas) and `presence.sync` (send me everyone). */
export const PresenceRefPayload = z.object({
  projectId: ProjectId,
  key: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).default('tab'),
});
export type PresenceRefPayload = z.infer<typeof PresenceRefPayload>;

/** One person on one tab, as the room fans it out. */
export interface PresenceEntry {
  /** `<connId>:<key>`: unique per browser tab. */
  id: string;
  userId: string;
  name: string;
  image: string | null;
  canEdit: boolean;
  cursor: PresenceCursor | null;
  selection: string[];
  /** Last update (epoch ms). */
  at: number;
}

/** Initials for an avatar without a photo (first letters of the first two words). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]!][0] ?? '?';
  const second = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : '';
  return (first + second).toUpperCase();
}

/**
 * Leading + trailing throttle: the first call runs at once, later calls inside
 * the window are coalesced and the latest runs when it ends.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number, now: () => number = Date.now): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let last = -Infinity;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const args = pending;
    pending = null;
    last = now();
    fn(...args);
  };
  const throttled = (...args: A) => {
    pending = args;
    const wait = last + ms - now();
    if (wait <= 0 && !timer) run();
    else if (!timer) timer = setTimeout(run, Math.max(0, wait));
  };
  throttled.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return throttled;
}
