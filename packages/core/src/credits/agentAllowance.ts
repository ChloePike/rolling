/**
 * Agent allowance ledger (D-012): each plan includes a monthly allowance in
 * USD of gateway cost for agent turns. It runs inside the CreditAccount
 * Durable Object next to the credit ledger, so every workspace's holds are
 * serialized like credit holds:
 *
 *   hold (estimate) → settle (actual cost) | release (no LLM cost) | expire (alarm, crashed turn)
 *
 * - A hold is refused with AGENT_ALLOWANCE_EXHAUSTED when
 *   `used + held + estimate > allowance` (used = settled cost in the period).
 * - Settle charges the actual cost even above the estimate (the overrun is
 *   recorded); a turn closes once. An expired hold can still be settled, so a
 *   turn that finishes after the alarm is charged what it really cost.
 * - Amounts are integer micro-USD. Operations are idempotent by key, like the
 *   credit ledger (same key + same arguments → first result).
 */
import { AGENT_ESTIMATE_WINDOW, microsToUsd, rollingAverage, usdToMicros } from '../pricing/agent';
import type { IdemRecord } from './types';
import { LedgerError } from './types';

/** Holds older than this are released by the CreditAccount alarm (crashed turns). */
export const AGENT_HOLD_TTL_MS = 10 * 60 * 1000;

export type AgentHoldStatus = 'held' | 'settled' | 'released' | 'expired';

export interface AgentHoldRecord {
  turnId: string;
  userId: string;
  /** Public LLM id (never a gateway id). */
  llm: string;
  periodStart: number;
  estimateMicros: number;
  actualMicros: number | null;
  overrunMicros: number;
  status: AgentHoldStatus;
  createdAt: number;
  closedAt: number | null;
}

export interface AgentAllowanceStore {
  transaction<T>(fn: () => T): T;
  getAgentHold(turnId: string): AgentHoldRecord | null;
  putAgentHold(hold: AgentHoldRecord): void;
  /** Sum of `actualMicros` of settled holds of the period. */
  agentUsedMicros(periodStart: number): number;
  /** Open (`held`) holds, any period. */
  openAgentHolds(): AgentHoldRecord[];
  /** `actualMicros` of the newest settled holds of `llm`, newest first. */
  recentAgentCosts(llm: string, limit: number): number[];
  getIdem(key: string): IdemRecord | null;
  putIdem(record: IdemRecord): void;
}

export interface AgentPeriodInput {
  allowanceUsd: number;
  periodStart: number;
  resetsAt: number;
}

export interface AgentHoldInput extends AgentPeriodInput {
  turnId: string;
  userId: string;
  llm: string;
  /** Fallback estimate (token prices × default turn size); the model's rolling average wins when it has history. */
  estimateUsd: number;
  idemKey: string;
}

export interface AgentHoldResult {
  turnId: string;
  llm: string;
  estimateUsd: number;
  allowanceUsd: number;
  usedUsd: number;
  heldUsd: number;
  resetsAt: number;
}

export interface AgentSettleResult {
  turnId: string;
  llm: string;
  actualUsd: number;
  overrunUsd: number;
  periodStart: number;
}

export interface AgentReleaseResult {
  turnId: string;
  released: boolean;
}

export interface AgentUsageResult {
  allowanceUsd: number;
  usedUsd: number;
  heldUsd: number;
  resetsAt: number;
  /** Estimated cost of one turn per requested model (rolling average, else the given default). */
  estimates: Record<string, number>;
}

function requireKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) throw new LedgerError('BAD_REQUEST', 'An idempotency key is required.');
  return key;
}

function requireUsd(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new LedgerError('BAD_REQUEST', `${name} must be a non-negative number.`);
  return v;
}

export class AgentAllowanceLedger {
  constructor(
    private readonly store: AgentAllowanceStore,
    private readonly deps: { now(): number },
  ) {}

  /** Estimated turn cost for `llm` in micro-USD: rolling average of recent turns, else `fallbackUsd`. */
  estimateMicros(llm: string, fallbackUsd: number): number {
    const avg = rollingAverage(this.store.recentAgentCosts(llm, AGENT_ESTIMATE_WINDOW));
    return avg !== null ? Math.round(avg) : usdToMicros(fallbackUsd);
  }

  private heldMicros(): number {
    return this.store.openAgentHolds().reduce((s, h) => s + h.estimateMicros, 0);
  }

  usage(input: AgentPeriodInput & { models?: { id: string; fallbackUsd: number }[] }): AgentUsageResult {
    const estimates: Record<string, number> = {};
    for (const m of input.models ?? []) estimates[m.id] = microsToUsd(this.estimateMicros(m.id, m.fallbackUsd));
    return {
      allowanceUsd: input.allowanceUsd,
      usedUsd: microsToUsd(this.store.agentUsedMicros(input.periodStart)),
      heldUsd: microsToUsd(this.heldMicros()),
      resetsAt: input.resetsAt,
      estimates,
    };
  }

  hold(input: AgentHoldInput): AgentHoldResult {
    const key = requireKey(input.idemKey);
    requireUsd(input.allowanceUsd, 'allowanceUsd');
    requireUsd(input.estimateUsd, 'estimateUsd');
    if (!input.turnId || !input.llm) throw new LedgerError('BAD_REQUEST', 'turnId and llm are required.');
    return this.idempotent('agentHold', key, input, (now) => {
      const existing = this.store.getAgentHold(input.turnId);
      if (existing) throw new LedgerError('JOB_CLOSED', 'This turn already has a hold.', { turnId: input.turnId, status: existing.status });
      const allowance = usdToMicros(input.allowanceUsd);
      const used = this.store.agentUsedMicros(input.periodStart);
      const held = this.heldMicros();
      const estimate = this.estimateMicros(input.llm, input.estimateUsd);
      if (used + held + estimate > allowance) {
        throw new LedgerError('AGENT_ALLOWANCE_EXHAUSTED', 'The agent allowance for this period is used up.', {
          allowanceUsd: input.allowanceUsd,
          usedUsd: microsToUsd(used + held),
          resetsAt: input.resetsAt,
          model: input.llm,
          estTurnUsd: microsToUsd(estimate),
        });
      }
      this.store.putAgentHold({
        turnId: input.turnId,
        userId: input.userId,
        llm: input.llm,
        periodStart: input.periodStart,
        estimateMicros: estimate,
        actualMicros: null,
        overrunMicros: 0,
        status: 'held',
        createdAt: now,
        closedAt: null,
      });
      return {
        turnId: input.turnId,
        llm: input.llm,
        estimateUsd: microsToUsd(estimate),
        allowanceUsd: input.allowanceUsd,
        usedUsd: microsToUsd(used),
        heldUsd: microsToUsd(held + estimate),
        resetsAt: input.resetsAt,
      };
    });
  }

  settle(input: { turnId: string; actualUsd: number; idemKey: string }): AgentSettleResult {
    const key = requireKey(input.idemKey);
    requireUsd(input.actualUsd, 'actualUsd');
    return this.idempotent('agentSettle', key, input, (now) => {
      const h = this.store.getAgentHold(input.turnId);
      if (!h) throw new LedgerError('NOT_FOUND', 'No hold for this turn.', { turnId: input.turnId });
      if (h.status !== 'held' && h.status !== 'expired') throw new LedgerError('JOB_CLOSED', 'This turn is already closed.', { turnId: input.turnId, status: h.status });
      const actual = usdToMicros(input.actualUsd);
      const overrun = Math.max(0, actual - h.estimateMicros);
      this.store.putAgentHold({ ...h, status: 'settled', actualMicros: actual, overrunMicros: overrun, closedAt: now });
      return { turnId: h.turnId, llm: h.llm, actualUsd: microsToUsd(actual), overrunUsd: microsToUsd(overrun), periodStart: h.periodStart };
    });
  }

  /** Releases a hold with no LLM cost (cancel or failure before the first response). */
  release(input: { turnId: string; idemKey: string }): AgentReleaseResult {
    const key = requireKey(input.idemKey);
    return this.idempotent('agentRelease', key, input, (now) => {
      const h = this.store.getAgentHold(input.turnId);
      if (!h) throw new LedgerError('NOT_FOUND', 'No hold for this turn.', { turnId: input.turnId });
      if (h.status === 'settled' || h.status === 'released') throw new LedgerError('JOB_CLOSED', 'This turn is already closed.', { turnId: input.turnId, status: h.status });
      this.store.putAgentHold({ ...h, status: 'released', actualMicros: 0, closedAt: now });
      return { turnId: h.turnId, released: true };
    });
  }

  /** Alarm: holds older than the TTL stop counting (crashed turns). Returns how many expired. */
  expireStale(now = this.deps.now(), ttlMs = AGENT_HOLD_TTL_MS): number {
    return this.store.transaction(() => {
      let n = 0;
      for (const h of this.store.openAgentHolds()) {
        if (h.createdAt + ttlMs <= now) {
          this.store.putAgentHold({ ...h, status: 'expired', closedAt: now });
          n++;
        }
      }
      return n;
    });
  }

  /** When the next open hold goes stale, for the alarm; null without open holds. */
  nextStaleAt(ttlMs = AGENT_HOLD_TTL_MS): number | null {
    const open = this.store.openAgentHolds();
    return open.length ? Math.min(...open.map((h) => h.createdAt + ttlMs)) : null;
  }

  private idempotent<T>(op: string, key: string, args: unknown, fn: (now: number) => T): T {
    const fingerprint = JSON.stringify(args);
    return this.store.transaction(() => {
      const prior = this.store.getIdem(key);
      if (prior) {
        if (prior.op !== op || prior.fingerprint !== fingerprint) {
          throw new LedgerError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.', { key, op: prior.op });
        }
        return prior.result as T;
      }
      const now = this.deps.now();
      const result = fn(now);
      this.store.putIdem({ key, op, fingerprint, result, createdAt: now });
      return result;
    });
  }
}

/** In-memory store for tests and tools. Transactions roll back on throw. */
export class MemoryAgentAllowanceStore implements AgentAllowanceStore {
  private holds = new Map<string, AgentHoldRecord>();
  private idem = new Map<string, IdemRecord>();
  /** Settle order, for `recentAgentCosts`. */
  private order: string[] = [];

  transaction<T>(fn: () => T): T {
    const snap = { holds: structuredClone(this.holds), idem: structuredClone(this.idem), order: [...this.order] };
    try {
      return fn();
    } catch (e) {
      this.holds = snap.holds;
      this.idem = snap.idem;
      this.order = snap.order;
      throw e;
    }
  }
  getAgentHold(turnId: string): AgentHoldRecord | null {
    const h = this.holds.get(turnId);
    return h ? { ...h } : null;
  }
  putAgentHold(hold: AgentHoldRecord): void {
    if (hold.status === 'settled' && this.holds.get(hold.turnId)?.status !== 'settled') this.order.push(hold.turnId);
    this.holds.set(hold.turnId, { ...hold });
  }
  agentUsedMicros(periodStart: number): number {
    let s = 0;
    for (const h of this.holds.values()) if (h.status === 'settled' && h.periodStart === periodStart) s += h.actualMicros ?? 0;
    return s;
  }
  openAgentHolds(): AgentHoldRecord[] {
    return [...this.holds.values()].filter((h) => h.status === 'held').map((h) => ({ ...h }));
  }
  recentAgentCosts(llm: string, limit: number): number[] {
    const out: number[] = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const h = this.holds.get(this.order[i]!)!;
      if (h.llm === llm) out.push(h.actualMicros ?? 0);
    }
    return out;
  }
  getIdem(key: string): IdemRecord | null {
    const r = this.idem.get(key);
    return r ? structuredClone(r) : null;
  }
  putIdem(record: IdemRecord): void {
    this.idem.set(record.key, structuredClone(record));
  }
  allAgentHolds(): AgentHoldRecord[] {
    return [...this.holds.values()].map((h) => ({ ...h }));
  }
}
