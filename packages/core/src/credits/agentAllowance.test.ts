/**
 * Agent allowance ledger (D-012): hold → settle | release | expire, idempotent
 * by key; property tests over random interleavings of concurrent turns.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { usdToMicros } from '../pricing/agent';
import { AGENT_HOLD_TTL_MS, AgentAllowanceLedger, MemoryAgentAllowanceStore } from './agentAllowance';
import { LedgerError } from './types';

const T0 = Date.UTC(2026, 10, 1);
const PERIOD = { allowanceUsd: 1.2, periodStart: T0, resetsAt: Date.UTC(2026, 11, 1) };

function make() {
  const clock = { now: T0 };
  const store = new MemoryAgentAllowanceStore();
  const ledger = new AgentAllowanceLedger(store, { now: () => clock.now });
  return { ledger, store, clock };
}

const hold = (l: AgentAllowanceLedger, turnId: string, estimateUsd: number, extra: Partial<typeof PERIOD> & { llm?: string } = {}) =>
  l.hold({ ...PERIOD, turnId, userId: 'u1', llm: 'claude-opus-5.5', estimateUsd, idemKey: `${turnId}:hold`, ...extra });

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
};

describe('agent allowance ledger', () => {
  it('holds the estimate and settles the actual cost', () => {
    const { ledger } = make();
    const h = hold(ledger, 't1', 0.064);
    expect(h).toMatchObject({ estimateUsd: 0.064, usedUsd: 0, heldUsd: 0.064, allowanceUsd: 1.2 });
    expect(ledger.usage(PERIOD)).toMatchObject({ usedUsd: 0, heldUsd: 0.064 });
    const s = ledger.settle({ turnId: 't1', actualUsd: 0.07, idemKey: 't1:settle' });
    expect(s).toMatchObject({ actualUsd: 0.07, overrunUsd: 0.006 });
    expect(ledger.usage(PERIOD)).toMatchObject({ usedUsd: 0.07, heldUsd: 0 });
  });

  it('refuses a hold when used + held + estimate > allowance, with the reset date', () => {
    const { ledger } = make();
    hold(ledger, 't1', 1.0);
    ledger.settle({ turnId: 't1', actualUsd: 1.0, idemKey: 't1:settle' });
    let err: LedgerError | null = null;
    try {
      hold(ledger, 't2', 0.25, { llm: 'gpt-6-astra' });
    } catch (e) {
      err = e as LedgerError;
    }
    expect(err?.code).toBe('AGENT_ALLOWANCE_EXHAUSTED');
    expect(err?.data).toMatchObject({ allowanceUsd: 1.2, usedUsd: 1.0, resetsAt: PERIOD.resetsAt, model: 'gpt-6-astra' });
    // A cheaper model still fits.
    expect(hold(ledger, 't3', 0.001, { llm: 'deepseek-v4.1-flash' }).estimateUsd).toBe(0.001);
  });

  it('counts open holds of concurrent turns', () => {
    const { ledger } = make();
    hold(ledger, 'a', 0.5);
    hold(ledger, 'b', 0.5);
    expect(code(() => hold(ledger, 'c', 0.5))).toBe('AGENT_ALLOWANCE_EXHAUSTED');
    ledger.release({ turnId: 'a', idemKey: 'a:release' });
    expect(code(() => hold(ledger, 'c', 0.5))).toBeNull();
  });

  it('resets with a new period', () => {
    const { ledger } = make();
    hold(ledger, 't1', 1.2);
    ledger.settle({ turnId: 't1', actualUsd: 1.2, idemKey: 't1:settle' });
    expect(code(() => hold(ledger, 't2', 0.01))).toBe('AGENT_ALLOWANCE_EXHAUSTED');
    const next = { allowanceUsd: 1.2, periodStart: PERIOD.resetsAt, resetsAt: Date.UTC(2027, 0, 1) };
    expect(ledger.usage(next).usedUsd).toBe(0);
    expect(code(() => hold(ledger, 't2', 0.01, next))).toBeNull();
  });

  it('estimates from the rolling average of the model once it has history', () => {
    const { ledger } = make();
    hold(ledger, 't1', 0.064);
    ledger.settle({ turnId: 't1', actualUsd: 0.02, idemKey: 't1:s' });
    hold(ledger, 't2', 0.064);
    ledger.settle({ turnId: 't2', actualUsd: 0.04, idemKey: 't2:s' });
    expect(hold(ledger, 't3', 0.064).estimateUsd).toBe(0.03);
    const u = ledger.usage({ ...PERIOD, models: [{ id: 'claude-opus-5.5', fallbackUsd: 0.064 }, { id: 'glm-5.3', fallbackUsd: 0.019 }] });
    expect(u.estimates).toEqual({ 'claude-opus-5.5': 0.03, 'glm-5.3': 0.019 });
  });

  it('is idempotent by key and closes a turn once', () => {
    const { ledger } = make();
    const a = hold(ledger, 't1', 0.1);
    expect(hold(ledger, 't1', 0.1)).toEqual(a);
    expect(code(() => ledger.hold({ ...PERIOD, turnId: 't1', userId: 'u1', llm: 'claude-opus-5.5', estimateUsd: 0.1, idemKey: 'other' }))).toBe('JOB_CLOSED');
    const s = ledger.settle({ turnId: 't1', actualUsd: 0.05, idemKey: 't1:settle' });
    expect(ledger.settle({ turnId: 't1', actualUsd: 0.05, idemKey: 't1:settle' })).toEqual(s);
    expect(code(() => ledger.settle({ turnId: 't1', actualUsd: 0.09, idemKey: 't1:settle' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(() => ledger.settle({ turnId: 't1', actualUsd: 0.05, idemKey: 't1:settle2' }))).toBe('JOB_CLOSED');
    expect(code(() => ledger.release({ turnId: 't1', idemKey: 't1:release' }))).toBe('JOB_CLOSED');
    expect(ledger.usage(PERIOD).usedUsd).toBe(0.05);
    expect(code(() => ledger.settle({ turnId: 'nope', actualUsd: 0, idemKey: 'x' }))).toBe('NOT_FOUND');
  });

  it('expires stale holds on the alarm, and still charges a late settle', () => {
    const { ledger, clock } = make();
    hold(ledger, 't1', 1.0);
    expect(ledger.nextStaleAt()).toBe(T0 + AGENT_HOLD_TTL_MS);
    clock.now += AGENT_HOLD_TTL_MS - 1;
    expect(ledger.expireStale()).toBe(0);
    clock.now += 1;
    expect(ledger.expireStale()).toBe(1);
    expect(ledger.nextStaleAt()).toBeNull();
    expect(ledger.usage(PERIOD)).toMatchObject({ usedUsd: 0, heldUsd: 0 });
    ledger.settle({ turnId: 't1', actualUsd: 0.3, idemKey: 't1:settle' });
    expect(ledger.usage(PERIOD).usedUsd).toBe(0.3);
  });
});

// ---------------------------------------------------------------- properties

type Op =
  | { t: 'hold'; estimate: number }
  | { t: 'settle'; pick: number; factor: number }
  | { t: 'release'; pick: number }
  | { t: 'repeat'; pick: number }
  | { t: 'time'; minutes: number }
  | { t: 'alarm' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('hold' as const), estimate: fc.double({ min: 0.0001, max: 0.4, noNaN: true }) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('settle' as const), pick: fc.nat(), factor: fc.double({ min: 0, max: 1.5, noNaN: true }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('release' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('repeat' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('time' as const), minutes: fc.integer({ min: 0, max: 15 }) }) },
  { weight: 1, arbitrary: fc.constant({ t: 'alarm' as const }) },
);

describe('agent allowance properties', () => {
  it('concurrent turns never exceed the allowance plus their overruns; every turn closes once', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const { ledger, store, clock } = make();
        const allowance = usdToMicros(PERIOD.allowanceUsd);
        const turns: { id: string; estimate: number }[] = [];
        const calls: { call: () => unknown; result: unknown }[] = [];
        let n = 0;
        const expired = new Set<string>();
        const run = (call: () => unknown): boolean => {
          try {
            calls.push({ call, result: call() });
            return true;
          } catch (e) {
            if (!(e instanceof LedgerError)) throw e;
            expect(['AGENT_ALLOWANCE_EXHAUSTED', 'JOB_CLOSED', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT']).toContain(e.code);
            return false;
          }
        };
        for (const op of ops) {
          if (op.t === 'hold') {
            const id = `t${++n}`;
            if (run(() => hold(ledger, id, op.estimate))) turns.push({ id, estimate: op.estimate });
          } else if (op.t === 'settle' && turns.length) {
            const t = turns[op.pick % turns.length]!;
            const h = store.getAgentHold(t.id)!;
            const actual = (h.estimateMicros * op.factor) / 1e6;
            run(() => ledger.settle({ turnId: t.id, actualUsd: actual, idemKey: `${t.id}:settle` }));
          } else if (op.t === 'release' && turns.length) {
            const t = turns[op.pick % turns.length]!;
            run(() => ledger.release({ turnId: t.id, idemKey: `${t.id}:release` }));
          } else if (op.t === 'repeat' && calls.length) {
            const c = calls[op.pick % calls.length]!;
            // Same key + same arguments → same result (holds re-run their closure with the same key).
            try {
              expect(c.call()).toEqual(c.result);
            } catch (e) {
              if (!(e instanceof LedgerError)) throw e;
            }
          } else if (op.t === 'time') {
            clock.now += op.minutes * 60_000;
          } else if (op.t === 'alarm') {
            ledger.expireStale();
            for (const h of store.allAgentHolds()) if (h.status === 'expired') expired.add(h.turnId);
          }

          const holds = store.allAgentHolds();
          const used = store.agentUsedMicros(PERIOD.periodStart);
          const held = store.openAgentHolds().reduce((s, h) => s + h.estimateMicros, 0);
          const overruns = holds.reduce((s, h) => s + h.overrunMicros, 0);
          // Expired holds settled later are charged outside the reservation: count them as overrun.
          const late = holds.filter((h) => h.status === 'settled' && expired.has(h.turnId)).reduce((s, h) => s + Math.min(h.actualMicros ?? 0, h.estimateMicros), 0);
          expect(used + held).toBeLessThanOrEqual(allowance + overruns + late);
          expect(used).toBeGreaterThanOrEqual(0);
          for (const h of holds) {
            if (h.status === 'settled') expect(h.actualMicros).not.toBeNull();
            if (h.status === 'released') expect(h.actualMicros).toBe(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('sequential turns overrun the allowance by at most one turn', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: 0.001, max: 0.3, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true })), { maxLength: 60 }), (turns) => {
        const { ledger, store } = make();
        let maxOverrun = 0;
        for (const [i, [estimate, factor]] of turns.entries()) {
          const id = `s${i}`;
          if (code(() => hold(ledger, id, estimate)) !== null) continue;
          const h = store.getAgentHold(id)!;
          const s = ledger.settle({ turnId: id, actualUsd: (h.estimateMicros * factor) / 1e6, idemKey: `${id}:settle` });
          maxOverrun = Math.max(maxOverrun, usdToMicros(s.overrunUsd));
          expect(store.agentUsedMicros(PERIOD.periodStart)).toBeLessThanOrEqual(usdToMicros(PERIOD.allowanceUsd) + maxOverrun);
        }
      }),
      { numRuns: 300 },
    );
  });
});
