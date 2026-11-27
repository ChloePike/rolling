/** The trial bucket in the credit ledger (D-022). */
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { TRIAL } from '../pricing/config';
import { trialGrant } from '../pricing/trial';
import { addMonths, reconcile } from './ledger';
import { makeLedger } from './testkit';
import { LedgerError } from './types';

const catalog = fixtureCatalog.models;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

const mini = (ref: string, resolution = '480p', seconds = 5) => ({ ref, modelId: 'bytedance/seedance-2.0-mini', request: { resolution, seconds } });
const lite = (ref: string, n = 1) => ({ ref, modelId: 'bytedance/seedream-5.0-lite', request: { n } });

function trialAccount() {
  const t = makeLedger(T0);
  const g = trialGrant(T0);
  t.ledger.grantTrial(g.credits, g.expiresAt, 'trial:ws_1');
  return t;
}

function err(fn: () => unknown): LedgerError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
  throw new Error('expected a LedgerError');
}

describe('grantTrial', () => {
  it('puts the trial credits in their own bucket until the trial ends', () => {
    const { ledger, store } = trialAccount();
    expect(ledger.balance()).toEqual({ plan: 0, purchased: 0, held: 0, planExpiresAt: null, trial: TRIAL.credits, trialExpiresAt: T0 + 14 * DAY });
    expect(store.allLines()).toMatchObject([{ kind: 'grant', bucket: 'trial', amount: TRIAL.credits, note: 'trial' }]);
    expect(ledger.trialStatus()).toBe('active');
  });

  it('is idempotent by key and happens once per workspace with any key', () => {
    const { ledger, store } = trialAccount();
    expect(ledger.grantTrial(TRIAL.credits, T0 + 14 * DAY, 'trial:ws_1')).toMatchObject({ granted: TRIAL.credits });
    expect(ledger.grantTrial(TRIAL.credits, T0 + 14 * DAY, 'trial:again')).toMatchObject({ granted: 0, skipped: 'already' });
    expect(store.allLines()).toHaveLength(1);
    expect(ledger.balance().trial).toBe(TRIAL.credits);
  });

  it('accounts without a trial keep the original balance shape', () => {
    const { ledger } = makeLedger(T0);
    expect(ledger.balance()).toEqual({ plan: 0, purchased: 0, held: 0, planExpiresAt: null });
    expect(ledger.trialStatus()).toBe('none');
  });

  it('rejects bad input', () => {
    const { ledger } = makeLedger(T0);
    expect(err(() => ledger.grantTrial(0, T0 + DAY, 'k')).code).toBe('BAD_REQUEST');
    expect(err(() => ledger.grantTrial(10, T0 - 1, 'k')).code).toBe('BAD_REQUEST');
  });
});

describe('quotes and holds without a plan', () => {
  it('prices under the trial caps and blocks what the trial does not include', () => {
    const { ledger } = trialAccount();
    const q = ledger.quote(
      [mini('ok'), mini('hd', '720p'), mini('long', '480p', 8), lite('img', 2), { ref: 'pro', modelId: 'bytedance/seedance-2.5', request: { resolution: '480p', seconds: 5 } }],
      catalog,
    );
    expect(q.trial).toBe(true);
    expect(q.items).toEqual([
      { ref: 'ok', modelId: 'bytedance/seedance-2.0-mini', credits: 53 },
      { ref: 'hd', modelId: 'bytedance/seedance-2.0-mini', credits: 0, blocked: 'trial_locked', lowestPlan: 'starter', trialLock: 'resolution' },
      { ref: 'long', modelId: 'bytedance/seedance-2.0-mini', credits: 0, blocked: 'trial_locked', lowestPlan: 'starter', trialLock: 'duration' },
      { ref: 'img', modelId: 'bytedance/seedream-5.0-lite', credits: 21 },
      { ref: 'pro', modelId: 'bytedance/seedance-2.5', credits: 0, blocked: 'trial_locked', lowestPlan: 'starter', trialLock: 'model' },
    ]);
    expect(q).toMatchObject({ total: 74, balance: TRIAL.credits, balanceAfter: TRIAL.credits - 74 });
  });

  it('holds and settles from trial credits only', () => {
    const { ledger, store } = trialAccount();
    const q = ledger.quote([mini('v'), lite('i')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    expect(h.total).toBe(64);
    expect(store.getHold(h.jobs[0]!.jobId)).toMatchObject({ fromTrial: 53, fromPlan: 0, fromPurchased: 0 });
    ledger.settle(h.jobs[0]!.jobId, 50, 's1');
    ledger.release(h.jobs[1]!.jobId, 'failed', 'r1');
    expect(ledger.balance()).toMatchObject({ trial: TRIAL.credits - 50, held: 0 });
    const r = reconcile(store.allLines());
    expect(r).toMatchObject({ trial: TRIAL.credits - 50, plan: 0, purchased: 0, held: 0, spent: 50 });
  });

  it('answers INSUFFICIENT_CREDITS (trial used) when the trial cannot cover a run', () => {
    const { ledger } = trialAccount();
    const q = ledger.quote([mini('a'), mini('b'), mini('c')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1', refs: ['a', 'b'] });
    ledger.settle(h.jobs[0]!.jobId, 53, 's1');
    const e = err(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h2', refs: ['c'] }));
    expect(e.code).toBe('INSUFFICIENT_CREDITS');
    expect(e.data).toMatchObject({ needed: 53, balance: TRIAL.credits - 106, trial: 'used' });
  });

  it('caps jobs at once for trials', () => {
    const { ledger } = trialAccount();
    const q = ledger.quote([lite('a'), lite('b'), lite('c')], catalog);
    expect(err(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' })).data).toMatchObject({ limit: TRIAL.concurrentJobs });
  });

  it('answers NO_PLAN with the trial state once it is used up or over', () => {
    const { ledger, clock } = trialAccount();
    const q = ledger.quote([mini('v')], catalog);
    clock.now = T0 + 15 * DAY;
    // The trial ended: the quote (priced as a trial) can no longer be held.
    const e = err(() => ledger.hold({ quoteId: ledger.quote([mini('v2')], catalog).quoteId, runId: 'run_2', userId: 'u1', idemKey: 'h2' }));
    expect(e.code).toBe('NO_PLAN');
    expect(e.data).toEqual({ trial: 'expired' });
    expect(q.trial).toBe(true);
    // Without any trial: NO_PLAN without trial data.
    const plain = makeLedger(T0);
    const e2 = err(() => plain.ledger.hold({ quoteId: plain.ledger.quote([mini('v')], catalog).quoteId, runId: 'r', userId: 'u', idemKey: 'h' }));
    expect(e2.code).toBe('NO_PLAN');
    expect(e2.data).toEqual({});
  });

  it('does not let a quote priced as a member be held on trial credits', () => {
    const { ledger, clock } = trialAccount();
    ledger.grant({ planId: 'starter', interval: 'month', start: T0, end: T0 + 2 * DAY }, 'inv_1');
    const q = ledger.quote([{ ref: 'pro', modelId: 'bytedance/seedance-2.5', request: { resolution: '720p', seconds: 5 } }], catalog);
    expect(q.trial).toBeUndefined();
    clock.now = T0 + 3 * DAY; // the plan lapsed, the trial is still on
    expect(err(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' })).code).toBe('QUOTE_EXPIRED');
    const q2 = ledger.quote([{ ref: 'pro', modelId: 'bytedance/seedance-2.5', request: { resolution: '720p', seconds: 5 } }], catalog);
    expect(q2.items[0]).toMatchObject({ blocked: 'trial_locked' });
  });
});

describe('members with trial credits left', () => {
  it('spend trial credits first, then plan, then purchased, without trial caps', () => {
    const { ledger, store } = trialAccount();
    ledger.grant({ planId: 'plus', interval: 'month', start: T0, end: addMonths(T0, 1) }, 'inv_1');
    ledger.purchase(1000, 'pi_1', 'p1');
    const q = ledger.quote([{ ref: 'v', modelId: 'bytedance/seedance-2.5', request: { resolution: '1080p', seconds: 5 } }], catalog);
    expect(q.trial).toBeUndefined();
    expect(q.balance).toBe(TRIAL.credits + 800 + 1000);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    const hold = store.getHold(h.jobs[0]!.jobId)!;
    expect(hold.fromTrial).toBe(TRIAL.credits);
    expect(hold.fromPlan).toBe(Math.min(800, hold.credits - TRIAL.credits));
    expect(ledger.balance().trial).toBe(0);
  });
});

describe('trial expiry', () => {
  it('expires unused trial credits when the trial ends (alarm or next operation)', () => {
    const { ledger, store, clock } = trialAccount();
    expect(ledger.nextExpiry()).toBe(T0 + 14 * DAY);
    clock.now = T0 + 14 * DAY;
    ledger.expire();
    expect(ledger.balance()).toMatchObject({ trial: 0, trialExpiresAt: T0 + 14 * DAY });
    expect(store.allLines().at(-1)).toMatchObject({ kind: 'expire', bucket: 'trial', amount: -TRIAL.credits });
    // Idempotent: a second pass writes nothing.
    const n = store.allLines().length;
    ledger.expire();
    expect(store.allLines()).toHaveLength(n);
    expect(ledger.nextExpiry()).toBeNull();
    expect(ledger.trialStatus()).toBe('expired');
  });

  it('expires trial credits a hold returns after the trial ended', () => {
    const { ledger, store, clock } = trialAccount();
    const q = ledger.quote([mini('v')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    clock.now = T0 + 14 * DAY + 1;
    ledger.release(h.jobs[0]!.jobId, 'failed', 'r1');
    expect(ledger.balance()).toMatchObject({ trial: 0, held: 0 });
    expect(store.allLines().filter((l) => l.bucket === 'trial' && l.kind === 'expire').map((l) => l.amount)).toEqual([-(TRIAL.credits - 53), -53]);
    const r = reconcile(store.allLines());
    expect(r).toMatchObject({ trial: 0, held: 0 });
  });

  it('a running trial job still settles after the trial ended', () => {
    const { ledger, clock } = trialAccount();
    const q = ledger.quote([mini('v')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    clock.now = T0 + 20 * DAY;
    expect(ledger.settle(h.jobs[0]!.jobId, 53, 's1')).toMatchObject({ spent: 53, returned: 0 });
  });
});
