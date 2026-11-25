/**
 * Pure scheduling pieces of the transfer engine: backoff, Retry-After,
 * the adaptive (AIMD) global cap and fair part selection. No I/O here so the
 * rules are unit-tested directly.
 */
import type { Priority } from './types';

/** Exponential backoff with "equal jitter": half fixed, half random, capped. */
export function backoffDelay(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number }, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds from `now`; null if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** How long to wait before retrying: Retry-After wins when the server sent one (never shorter than backoff/4). */
export function retryDelay(
  attempt: number,
  retryAfter: string | null | undefined,
  opts: { baseDelayMs: number; maxDelayMs: number },
  now: number = Date.now(),
  random: () => number = Math.random,
): number {
  const fromHeader = parseRetryAfter(retryAfter, now);
  const backoff = backoffDelay(attempt, opts, random);
  if (fromHeader !== null) return Math.max(fromHeader, Math.round(backoff / 4));
  return backoff;
}

/** HTTP statuses worth retrying. 403/410 on signed URLs are handled separately (refresh the URL). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500 || status === 0;
}

/** Congestion signals that halve the adaptive cap. */
export function isCongestionStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504 || status >= 500;
}

/**
 * Additive-increase / multiplicative-decrease controller for the global cap
 * on upload parts in flight. +1 after a window (as many successes as the
 * current cap) whose throughput did not drop more than 10% below the previous
 * window; halve on a congestion signal (429, 5xx, stall), at most once per
 * `cooldownMs` so one burst of failures counts once.
 */
export class Aimd {
  cap: number;
  private successes = 0;
  private windowBytes = 0;
  private windowStart: number;
  private lastThroughput = 0;
  private lastDecreaseAt = -Infinity;

  constructor(
    initial: number,
    readonly min: number,
    readonly max: number,
    private readonly now: () => number = Date.now,
    readonly cooldownMs = 2000,
  ) {
    this.cap = clamp(initial, min, max);
    this.windowStart = now();
  }

  onSuccess(bytes: number): void {
    this.successes += 1;
    this.windowBytes += bytes;
    if (this.successes < this.cap) return;
    const elapsed = Math.max(1, this.now() - this.windowStart);
    const throughput = this.windowBytes / elapsed;
    const stable = this.lastThroughput === 0 || throughput >= this.lastThroughput * 0.9;
    if (stable && this.cap < this.max) this.cap += 1;
    this.lastThroughput = throughput;
    this.resetWindow();
  }

  /** Returns true when the cap actually changed. */
  onCongestion(): boolean {
    const t = this.now();
    if (t - this.lastDecreaseAt < this.cooldownMs) return false;
    this.lastDecreaseAt = t;
    const next = clamp(Math.floor(this.cap / 2), this.min, this.max);
    const changed = next !== this.cap;
    this.cap = next;
    this.lastThroughput = 0;
    this.resetWindow();
    return changed;
  }

  private resetWindow() {
    this.successes = 0;
    this.windowBytes = 0;
    this.windowStart = this.now();
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** What the picker needs to know about one runnable upload. */
export interface SchedFile {
  id: string;
  size: number;
  priority: Priority;
  createdAt: number;
  /** Already has parts in flight or done (keeps its slot; never preempted). */
  started: boolean;
  inFlight: number;
  /** Parts left to send (not done, not in flight, not waiting on a retry timer). */
  pending: number;
}

const rank = (p: Priority) => (p === 'high' ? 1 : 0);

/**
 * Which files hold an upload slot: those already started keep theirs; free
 * slots go to high priority first, then smaller files, then older ones. A
 * high-priority file may take one slot beyond `maxFiles` so the asset the user
 * waits on never queues behind large uploads.
 */
export function activeFiles(files: SchedFile[], maxFiles: number): SchedFile[] {
  const started = files.filter((f) => f.started);
  const waiting = files
    .filter((f) => !f.started)
    .sort((a, b) => rank(b.priority) - rank(a.priority) || a.size - b.size || a.createdAt - b.createdAt);
  const active = [...started];
  let extra = active.length > maxFiles ? 1 : 0;
  for (const f of waiting) {
    if (active.length < maxFiles) active.push(f);
    else if (f.priority === 'high' && extra === 0) {
      active.push(f);
      extra = 1;
    }
  }
  return active;
}

/**
 * Fair part selection: round-robin across active files, one part per file per
 * turn, high priority files first in each turn, then smaller files first.
 * Respects the per-file and global caps. Returns file ids, one per part to start.
 */
export function pickParts(files: SchedFile[], opts: { maxFiles: number; perFile: number; globalCap: number; inFlight: number }): string[] {
  const active = activeFiles(files, opts.maxFiles).sort(
    (a, b) => rank(b.priority) - rank(a.priority) || a.size - b.size || a.createdAt - b.createdAt,
  );
  const inFlight = new Map(active.map((f) => [f.id, f.inFlight]));
  const pending = new Map(active.map((f) => [f.id, f.pending]));
  let budget = opts.globalCap - opts.inFlight;
  const picks: string[] = [];
  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const f of active) {
      if (budget <= 0) break;
      if ((pending.get(f.id) ?? 0) <= 0 || (inFlight.get(f.id) ?? 0) >= opts.perFile) continue;
      picks.push(f.id);
      pending.set(f.id, pending.get(f.id)! - 1);
      inFlight.set(f.id, inFlight.get(f.id)! + 1);
      budget -= 1;
      progressed = true;
    }
  }
  return picks;
}
