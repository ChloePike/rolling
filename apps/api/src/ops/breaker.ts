/**
 * Gateway circuit breaker (D-030), D1-backed so every isolate, workflow and
 * cron sees one state per gateway (`gateway_breaker`). Rules are in
 * `@rolling/core/ops/breaker`.
 *
 * - `startRun` refuses with `503 GATEWAY_UNAVAILABLE` before anything is held;
 *   `advanceRun` marks waiting items failed instead of holding them.
 * - A submit while open fails at once (the job's hold is released by `failJob`,
 *   no retries); provider 5xx, timeouts and network errors on submit and poll
 *   count toward opening it.
 * - The status page shows it; the 5-minute probe closes it when the gateway answers.
 *
 * A short in-isolate cache (2 s) keeps hot paths to about one D1 read per isolate per window.
 */
import { CLOSED, DEFAULT_BREAKER, isOpen, onFailure, onSuccess, phaseOf, type BreakerConfig, type BreakerPhase, type BreakerState } from "@rolling/core/ops/breaker";
import { writeMetric } from "./metrics";

export const PRIMARY_GATEWAY = "hyperouter";
const CACHE_MS = 2000;

interface Row {
  state: "closed" | "open";
  failures: number;
  window_start: number;
  opened_at: number | null;
  open_until: number | null;
  last_error: string | null;
}

const cache = new Map<string, { at: number; state: BreakerState }>();
let configOverride: BreakerConfig | null = null;

/** Tests: a smaller threshold or window. */
export function setBreakerConfigForTests(cfg: BreakerConfig | null): void {
  configOverride = cfg;
  cache.clear();
}

export function breakerConfig(): BreakerConfig {
  return configOverride ?? DEFAULT_BREAKER;
}

function fromRow(r: Row | null): BreakerState {
  if (!r) return { ...CLOSED };
  return { state: r.state, failures: r.failures, windowStart: r.window_start, openedAt: r.opened_at, openUntil: r.open_until, lastError: r.last_error };
}

export async function readBreaker(env: Env, gateway = PRIMARY_GATEWAY, fresh = false): Promise<BreakerState> {
  const hit = cache.get(gateway);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.state;
  let state: BreakerState;
  try {
    state = fromRow(await env.DB.prepare("SELECT * FROM gateway_breaker WHERE gateway = ?").bind(gateway).first<Row>());
  } catch (err) {
    console.error(JSON.stringify({ msg: "breaker: read failed", error: String(err) }));
    state = { ...CLOSED };
  }
  cache.set(gateway, { at: Date.now(), state });
  return state;
}

async function write(env: Env, gateway: string, s: BreakerState): Promise<void> {
  cache.set(gateway, { at: Date.now(), state: s });
  await env.DB.prepare(
    `INSERT INTO gateway_breaker (gateway, state, failures, window_start, opened_at, open_until, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (gateway) DO UPDATE SET state = excluded.state, failures = excluded.failures, window_start = excluded.window_start,
       opened_at = excluded.opened_at, open_until = excluded.open_until, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  )
    .bind(gateway, s.state, s.failures, s.windowStart, s.openedAt, s.openUntil, s.lastError?.slice(0, 300) ?? null, Date.now())
    .run();
}

export async function breakerOpen(env: Env, gateway = PRIMARY_GATEWAY): Promise<boolean> {
  return isOpen(await readBreaker(env, gateway), Date.now());
}

export async function breakerPhase(env: Env, gateway = PRIMARY_GATEWAY): Promise<{ phase: BreakerPhase; state: BreakerState }> {
  const state = await readBreaker(env, gateway);
  return { phase: phaseOf(state, Date.now()), state };
}

/** A gateway outage signal (5xx, timeout, network). Read-modify-write; a lost race only delays opening by one failure. */
export async function recordGatewayFailure(env: Env, error: string, gateway = PRIMARY_GATEWAY): Promise<BreakerState> {
  try {
    const before = await readBreaker(env, gateway, true);
    const next = onFailure(before, Date.now(), error, breakerConfig());
    await write(env, gateway, next);
    if (before.state !== "open" && next.state === "open") {
      console.error(JSON.stringify({ msg: "breaker: OPEN", gateway, failures: next.failures, error }));
      writeMetric(env, { event: "breaker", blobs: [gateway, "open"], doubles: [1] });
    }
    return next;
  } catch (err) {
    console.error(JSON.stringify({ msg: "breaker: write failed", error: String(err) }));
    return { ...CLOSED };
  }
}

export async function recordGatewaySuccess(env: Env, gateway = PRIMARY_GATEWAY): Promise<void> {
  try {
    const before = await readBreaker(env, gateway);
    if (before.state === "closed" && before.failures === 0) return;
    await write(env, gateway, onSuccess(before));
    if (before.state === "open") {
      console.warn(JSON.stringify({ msg: "breaker: closed", gateway }));
      writeMetric(env, { event: "breaker", blobs: [gateway, "closed"], doubles: [0] });
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "breaker: write failed", error: String(err) }));
  }
}

/** Admin reset (audited by the route). */
export async function resetBreaker(env: Env, gateway = PRIMARY_GATEWAY): Promise<void> {
  await write(env, gateway, { ...CLOSED });
}
