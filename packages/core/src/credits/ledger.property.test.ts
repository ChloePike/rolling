/**
 * Property tests for the credit ledger (M2 acceptance): random sequences of
 * grants, purchases, quotes, holds, settles, releases, repeats, time jumps,
 * expiries and cancellations never break the money invariants.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import type { PlanId } from '../pricing/config';
import { addMonths, reconcile } from './ledger';
import { makeLedger } from './testkit';
import { LedgerError } from './types';

const catalog = fixtureCatalog.models;
const T0 = Date.UTC(2026, 10, 1);
const DAY = 86_400_000;

const itemArb = fc.oneof(
  fc.record({ modelId: fc.constant('bytedance/seedream-5.0-lite'), request: fc.record({ n: fc.integer({ min: 1, max: 4 }) }) }),
  fc.record({
    modelId: fc.constant('bytedance/seedance-2.5'),
    request: fc.record({ resolution: fc.constantFrom('480p', '720p', '1080p'), seconds: fc.integer({ min: 4, max: 12 }) }),
  }),
  fc.record({ modelId: fc.constant('unknown/model'), request: fc.constant({}) }),
  // D-022: a model in the trial set, inside and over the trial caps.
  fc.record({ modelId: fc.constant('bytedance/seedance-2.0-mini'), request: fc.record({ resolution: fc.constantFrom('480p', '720p'), seconds: fc.integer({ min: 4, max: 6 }) }) }),
);

type Op =
  | { t: 'grant'; plan: PlanId; interval: 'month' | 'year'; offsetDays: number }
  | { t: 'purchase'; credits: number }
  | { t: 'quoteHold'; items: { modelId: string; request: object }[]; limit: number | null; user: number; partial: boolean }
  | { t: 'holdRest'; pick: number }
  | { t: 'settle'; pick: number; factor: number }
  | { t: 'release'; pick: number }
  | { t: 'repeat'; pick: number }
  | { t: 'time'; hours: number }
  | { t: 'expire' }
  | { t: 'cancel' }
  | { t: 'trial'; credits: number; days: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant('grant' as const), plan: fc.constantFrom<PlanId>('starter', 'plus', 'pro'), interval: fc.constantFrom<'month' | 'year'>('month', 'year'), offsetDays: fc.integer({ min: -40, max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('purchase' as const), credits: fc.integer({ min: 1, max: 5000 }) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('quoteHold' as const), items: fc.array(itemArb, { minLength: 1, maxLength: 4 }), limit: fc.option(fc.integer({ min: 0, max: 3000 }), { nil: null }), user: fc.integer({ min: 0, max: 2 }), partial: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('holdRest' as const), pick: fc.nat() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('settle' as const), pick: fc.nat(), factor: fc.double({ min: 0, max: 2, noNaN: true }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('release' as const), pick: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('repeat' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('time' as const), hours: fc.integer({ min: 0, max: 24 * 45 }) }) },
  { weight: 1, arbitrary: fc.constant({ t: 'expire' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'cancel' as const }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('trial' as const), credits: fc.integer({ min: 1, max: 500 }), days: fc.integer({ min: 1, max: 20 }) }) },
);

const ALLOWED_ERRORS = new Set(['NO_PLAN', 'INSUFFICIENT_CREDITS', 'MEMBER_LIMIT_REACHED', 'CONCURRENCY_LIMIT', 'QUOTE_EXPIRED', 'JOB_CLOSED', 'NOT_FOUND', 'BAD_REQUEST']);

function runSequence(ops: Op[]) {
  const { ledger, store, clock } = makeLedger(T0);
  const done: { call: () => unknown; result: unknown }[] = [];
  const jobs: string[] = [];
  const quotes: { quoteId: string; runId: string; user: string; limit: number | null }[] = [];
  let n = 0;

  const attempt = (call: () => unknown) => {
    try {
      const result = call();
      done.push({ call, result: structuredClone(result) });
      return result;
    } catch (e) {
      if (e instanceof LedgerError && ALLOWED_ERRORS.has(e.code)) return null;
      throw e;
    }
  };

  for (const op of ops) {
    const i = ++n;
    switch (op.t) {
      case 'grant': {
        const start = clock.now + op.offsetDays * DAY;
        const end = op.interval === 'month' ? addMonths(start, 1) : addMonths(start, 12);
        attempt(() => ledger.grant({ planId: op.plan, interval: op.interval, start, end }, `g${i}`));
        break;
      }
      case 'purchase':
        attempt(() => ledger.purchase(op.credits, `pi_${i}`, `p${i}`));
        break;
      case 'quoteHold': {
        const q = ledger.quote(op.items.map((it, k) => ({ ref: `r${k}`, ...it })), catalog);
        const runId = `run_${i}`;
        const user = `u${op.user}`;
        quotes.push({ quoteId: q.quoteId, runId, user, limit: op.limit });
        const refs = op.partial ? q.items.filter((i) => !i.blocked).slice(0, 1).map((i) => i.ref) : undefined;
        const r = attempt(() => ledger.hold({ quoteId: q.quoteId, runId, userId: user, idemKey: `h${i}`, refs, memberMonthlyLimit: op.limit })) as { jobs: { jobId: string }[] } | null;
        r?.jobs.forEach((j) => jobs.push(j.jobId));
        break;
      }
      case 'holdRest': {
        const q = quotes[op.pick % Math.max(1, quotes.length)];
        if (!q) break;
        const r = attempt(() => ledger.hold({ quoteId: q.quoteId, runId: q.runId, userId: q.user, idemKey: `h${i}`, memberMonthlyLimit: q.limit })) as { jobs: { jobId: string }[] } | null;
        r?.jobs.forEach((j) => jobs.push(j.jobId));
        break;
      }
      case 'settle': {
        const jobId = jobs[op.pick % Math.max(1, jobs.length)];
        if (!jobId) break;
        const held = store.getHold(jobId)!.credits;
        attempt(() => ledger.settle(jobId, Math.floor(held * op.factor), `s${i}`));
        break;
      }
      case 'release': {
        const jobId = jobs[op.pick % Math.max(1, jobs.length)];
        if (jobId) attempt(() => ledger.release(jobId, 'failed', `r${i}`));
        break;
      }
      case 'repeat': {
        const prior = done[op.pick % Math.max(1, done.length)];
        if (prior) {
          // Idempotent repeats return the first result.
          let again: unknown;
          try {
            again = prior.call();
          } catch (e) {
            throw new Error(`repeat threw ${String(e)}`);
          }
          expect(again).toEqual(prior.result);
        }
        break;
      }
      case 'time':
        clock.now += op.hours * 3_600_000;
        break;
      case 'expire':
        ledger.expire();
        break;
      case 'cancel':
        attempt(() => ledger.cancelPlan(`c${i}`));
        break;
      case 'trial': {
        const expiresAt = clock.now + op.days * DAY;
        attempt(() => ledger.grantTrial(op.credits, expiresAt, `t${i}`));
        break;
      }
    }
    checkInvariants();
  }

  function checkInvariants() {
    const acct = store.getAccount();
    const holds = store.allHolds();
    const lines = store.allLines();
    // No bucket is ever negative.
    expect(acct.plan).toBeGreaterThanOrEqual(0);
    expect(acct.purchased).toBeGreaterThanOrEqual(0);
    expect(acct.held).toBeGreaterThanOrEqual(0);
    expect(acct.trial).toBeGreaterThanOrEqual(0);
    // held equals the open holds.
    expect(acct.held).toBe(holds.filter((h) => h.status === 'held').reduce((s, h) => s + h.credits, 0));
    // Totals reconcile with the ledger lines.
    const r = reconcile(lines);
    expect({ plan: r.plan, purchased: r.purchased, held: r.held, trial: r.trial }).toEqual({ plan: acct.plan, purchased: acct.purchased, held: acct.held, trial: acct.trial });
    // At most one trial grant per account, ever.
    expect(lines.filter((l) => l.kind === 'grant' && l.bucket === 'trial').length).toBeLessThanOrEqual(1);
    for (const h of holds) {
      expect((h.fromTrial ?? 0) + h.fromPlan + h.fromPurchased).toBe(h.credits);
      const jobLines = lines.filter((l) => l.jobId === h.jobId);
      const spent = 0 - jobLines.filter((l) => l.kind === 'settle').reduce((s, l) => s + l.amount, 0);
      // Settles never exceed holds.
      expect(spent).toBeLessThanOrEqual(h.credits);
      // A job settles or releases at most once.
      const closingOps = new Set(jobLines.filter((l) => l.kind === 'settle' || l.kind === 'release' || l.kind === 'refund').map((l) => l.idemKey.split('#')[0]));
      expect(closingOps.size).toBeLessThanOrEqual(1);
      expect(closingOps.size === 1).toBe(h.status !== 'held');
      if (h.status === 'settled') expect(spent).toBe(h.spent);
      if (h.status === 'released') expect(spent).toBe(0);
    }
    // Plan credits never outlive their slice.
    if (acct.plan > 0) expect(acct.planExpiresAt).not.toBeNull();
  }
}

describe('credit ledger properties', () => {
  it('no sequence of operations breaks the money invariants', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        runSequence(ops);
      }),
      { numRuns: 400 },
    );
  });

  it('total credits in equal credits out plus balances (conservation)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const { ledger, store, clock } = makeLedger(T0);
        ledger.grant({ planId: 'pro', interval: 'year', start: T0, end: addMonths(T0, 12) }, 'g0');
        let n = 0;
        const jobs: string[] = [];
        for (const op of ops) {
          n += 1;
          try {
            if (op.t === 'purchase') ledger.purchase(op.credits, `pi${n}`, `p${n}`);
            else if (op.t === 'quoteHold') {
              const q = ledger.quote(op.items.map((it, i) => ({ ref: `r${i}`, ...it })), catalog);
              ledger.hold({ quoteId: q.quoteId, runId: `run${n}`, userId: 'u', idemKey: `h${n}` }).jobs.forEach((j) => jobs.push(j.jobId));
            } else if (op.t === 'settle' && jobs.length) {
              const id = jobs[op.pick % jobs.length]!;
              ledger.settle(id, Math.floor(store.getHold(id)!.credits * op.factor), `s${n}`);
            } else if (op.t === 'release' && jobs.length) ledger.release(jobs[op.pick % jobs.length]!, 'x', `r${n}`);
            else if (op.t === 'time') clock.now += op.hours * 3_600_000;
          } catch (e) {
            if (!(e instanceof LedgerError)) throw e;
          }
        }
        ledger.expire();
        const lines = store.allLines();
        const sum = (k: string) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
        const into = sum('grant') + sum('purchase');
        const out = -sum('settle') - sum('expire');
        const b = ledger.balance();
        expect(into).toBe(out + b.plan + b.purchased + b.held);
      }),
      { numRuns: 200 },
    );
  });
});
