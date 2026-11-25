/**
 * Actions a paywall interrupted (D-007), kept in sessionStorage so they
 * resume after checkout, even across the Stripe redirect.
 *
 * - `savePendingAction(kind, data)` keeps the action in an unbound slot.
 * - When a checkout starts (`bindPendingToCheckout(sessionId)`), the unbound
 *   action moves to a slot keyed by that Stripe Checkout session.
 * - When that checkout completes (`markCheckoutResumed(sessionId)`, called
 *   before `onCheckoutResume` listeners run), its action becomes takeable;
 *   an abandoned checkout's action never replays after a different one.
 * - `takePendingAction(kind, accept?)` returns and clears the newest matching
 *   action (younger than an hour) that `accept` agrees to (e.g. same page).
 */
const KEY = 'rolling.pendingAction';
const MAX_AGE_MS = 3_600_000;

export interface PendingAction {
  /** Feature that resumes it, e.g. `canvas.run`, `home.agent`, `tools.run`, `editor.ask`. */
  kind: string;
  data: unknown;
  at: number;
}

/** Checkout sessions completed in this tab (their actions may replay). */
const resumed = new Set<string>();

/**
 * The Stripe return (`?checkout=success&session_id=…`) marks its session at
 * load, before the session runtime strips the params: pages that replay their
 * action on mount (canvas run, canvas agent) see it right away.
 */
function markReturnFromUrl(): void {
  try {
    if (typeof window === 'undefined' || !window.location) return;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('session_id');
    if (q.get('checkout') === 'success' && id) resumed.add(id);
  } catch {
    /* No location (tests). */
  }
}
markReturnFromUrl();

/** True when an action of `kind` is waiting (without taking it). */
export function hasPendingAction<T>(kind: string, accept: (data: T) => boolean = () => true): boolean {
  const s = storage();
  if (!s) return false;
  return [KEY, ...[...resumed].map((id) => `${KEY}:${id}`)].some((key) => {
    const p = read(s, key);
    return !!p && p.kind === kind && Date.now() - p.at <= MAX_AGE_MS && accept(p.data as T);
  });
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(s: Storage, key: string): PendingAction | null {
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingAction;
    return typeof p?.kind === 'string' && typeof p.at === 'number' ? p : null;
  } catch {
    return null;
  }
}

export function savePendingAction(kind: string, data: unknown): void {
  try {
    storage()?.setItem(KEY, JSON.stringify({ kind, data, at: Date.now() } satisfies PendingAction));
  } catch {
    /* Storage unavailable: the action is lost after a redirect. */
  }
}

/** A checkout started: the unbound action now belongs to `sessionId`. */
export function bindPendingToCheckout(sessionId: string | null | undefined): void {
  const s = storage();
  if (!s || !sessionId) return;
  const p = read(s, KEY);
  if (!p) return;
  try {
    s.setItem(`${KEY}:${sessionId}`, JSON.stringify(p));
    s.removeItem(KEY);
  } catch {
    /* Keep it unbound. */
  }
}

/** The checkout `sessionId` completed: its action may replay. */
export function markCheckoutResumed(sessionId: string | null | undefined): void {
  if (sessionId) resumed.add(sessionId);
}

/** Takes (and clears) the newest pending action of `kind` that `accept` agrees to. */
export function takePendingAction<T>(kind: string, accept: (data: T) => boolean = () => true): T | null {
  const s = storage();
  if (!s) return null;
  const keys = [KEY, ...[...resumed].map((id) => `${KEY}:${id}`)];
  let best: { key: string; p: PendingAction } | null = null;
  for (const key of keys) {
    const p = read(s, key);
    if (!p || p.kind !== kind) continue;
    if (Date.now() - p.at > MAX_AGE_MS) {
      s.removeItem(key);
      continue;
    }
    if (!accept(p.data as T)) continue;
    if (!best || p.at > best.p.at) best = { key, p };
  }
  if (!best) return null;
  try {
    s.removeItem(best.key);
  } catch {
    /* ignore */
  }
  return best.p.data as T;
}

/** Tests. */
export function resetPendingForTests(): void {
  resumed.clear();
}
