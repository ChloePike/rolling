import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { addMonths, monthKey, QUOTE_TTL_MS, reconcile } from './ledger';
import { makeLedger } from './testkit';
import { LedgerError } from './types';

const catalog = fixtureCatalog.models;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

const video = (ref: string, resolution = '720p', seconds = 5) => ({ ref, modelId: 'bytedance/seedance-2.5', request: { resolution, seconds } });
const image = (ref: string, n = 1) => ({ ref, modelId: 'bytedance/seedream-5.0-lite', request: { n } });

function member(plan: 'starter' | 'plus' | 'pro' = 'plus', interval: 'month' | 'year' = 'month') {
  const t = makeLedger(T0);
  const end = interval === 'month' ? addMonths(T0, 1) : addMonths(T0, 12);
  t.ledger.grant({ planId: plan, interval, start: T0, end }, 'inv_1');
  return t;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return 'OK';
}

describe('quote', () => {
  it('prices items with creditsFor and reports the balance after', () => {
    const { ledger } = member('plus');
    const q = ledger.quote([video('n1'), image('n2')], catalog);
    expect(q.items).toEqual([
      { ref: 'n1', modelId: 'bytedance/seedance-2.5', credits: 347 },
      { ref: 'n2', modelId: 'bytedance/seedream-5.0-lite', credits: 11 },
    ]);
    expect(q).toMatchObject({ total: 358, balance: 800, balanceAfter: 442, expiresAt: T0 + QUOTE_TTL_MS });
  });

  it('blocks unknown, unpriced and plan-locked items without charging for them', () => {
    const { ledger } = member('starter');
    const q = ledger.quote(
      [video('a', '1080p'), { ref: 'b', modelId: 'nope/model' }, video('c', '4K'), image('d')],
      catalog,
    );
    expect(q.items.map((i) => [i.ref, i.blocked ?? null, i.credits])).toEqual([
      ['a', 'resolution_locked', 0],
      ['b', 'unknown_model', 0],
      ['c', 'resolution_locked', 0],
      ['d', null, 11],
    ]);
    expect(q.items[0]!.lowestPlan).toBe('plus');
    expect(q.total).toBe(11);
  });

  it('rejects empty quotes and duplicate refs', () => {
    const { ledger } = member();
    expect(code(() => ledger.quote([], catalog))).toBe('BAD_REQUEST');
    expect(code(() => ledger.quote([image('a'), image('a')], catalog))).toBe('BAD_REQUEST');
  });
});

describe('hold', () => {
  it('takes plan credits first, then purchased', () => {
    const { ledger } = member('starter');
    ledger.purchase(1000, 'pi_1', 'topup:pi_1');
    const q = ledger.quote([video('a')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    expect(h.jobs).toHaveLength(1);
    expect(h.balance).toMatchObject({ plan: 0, purchased: 1000 - 147, held: 347 });
  });

  it('returns INSUFFICIENT_CREDITS with needed and balance', () => {
    const { ledger } = member('starter');
    const q = ledger.quote([video('a')], catalog);
    try {
      ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'INSUFFICIENT_CREDITS', data: { needed: 347, balance: 200 } });
    }
    expect(ledger.balance()).toMatchObject({ plan: 200, held: 0 });
  });

  it('requires a plan', () => {
    const { ledger } = makeLedger(T0);
    ledger.purchase(5000, 'pi_1', 'p1');
    const q = ledger.quote([image('a')], catalog);
    expect(code(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }))).toBe('NO_PLAN');
  });

  it('expires quotes after 10 minutes', () => {
    const { ledger, clock } = member();
    const q = ledger.quote([image('a')], catalog);
    clock.now += QUOTE_TTL_MS;
    expect(code(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }))).toBe('QUOTE_EXPIRED');
  });

  it('enforces the member monthly limit including open holds', () => {
    const { ledger } = member('pro');
    const q1 = ledger.quote([video('a')], catalog);
    ledger.hold({ quoteId: q1.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1', memberMonthlyLimit: 400 });
    const q2 = ledger.quote([video('b')], catalog);
    try {
      ledger.hold({ quoteId: q2.quoteId, runId: 'run_2', userId: 'u1', idemKey: 'h2', memberMonthlyLimit: 400 });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'MEMBER_LIMIT_REACHED', data: { limit: 400, used: 347, needed: 347 } });
    }
    // Another member is not affected.
    expect(code(() => ledger.hold({ quoteId: q2.quoteId, runId: 'run_2', userId: 'u2', idemKey: 'h3', memberMonthlyLimit: 400 }))).toBe('OK');
  });

  it('counts settled spend against the member limit in the same month only', () => {
    const { ledger, clock } = member('pro', 'year');
    const q1 = ledger.quote([video('a')], catalog);
    const h = ledger.hold({ quoteId: q1.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1', memberMonthlyLimit: 500 });
    ledger.settle(h.jobs[0]!.jobId, 300, 's1');
    const q2 = ledger.quote([video('b')], catalog);
    expect(code(() => ledger.hold({ quoteId: q2.quoteId, runId: 'run_2', userId: 'u1', idemKey: 'h2', memberMonthlyLimit: 500 }))).toBe('MEMBER_LIMIT_REACHED');
    clock.now = addMonths(T0, 1) + 1;
    const q3 = ledger.quote([video('c')], catalog);
    expect(code(() => ledger.hold({ quoteId: q3.quoteId, runId: 'run_3', userId: 'u1', idemKey: 'h3', memberMonthlyLimit: 500 }))).toBe('OK');
    expect(monthKey(clock.now)).toBe('2026-12');
  });

  it('enforces the plan concurrency limit by open holds', () => {
    const { ledger } = member('starter');
    ledger.purchase(10_000, 'pi', 'p');
    const q = ledger.quote([image('a'), image('b'), image('c')], catalog);
    try {
      ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'CONCURRENCY_LIMIT', data: { limit: 2, active: 0, requested: 3 } });
    }
    // Hold part of the quote now and the rest after a job finishes.
    const h1 = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1', refs: ['a', 'b'] });
    expect(h1.jobs.map((j) => j.ref)).toEqual(['a', 'b']);
    expect(code(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h2', refs: ['c'] }))).toBe('CONCURRENCY_LIMIT');
    ledger.settle(h1.jobs[0]!.jobId, 11, 's1');
    const h2 = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h2', refs: ['c'] });
    expect(h2.jobs.map((j) => j.ref)).toEqual(['c']);
    // The quote belongs to run_1 now.
    expect(code(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_2', userId: 'u1', idemKey: 'h3' }))).toBe('BAD_REQUEST');
  });

  it('returns the first result for a repeated key and refuses a reused key with other arguments', () => {
    const { ledger } = member();
    const q = ledger.quote([image('a')], catalog);
    const input = { quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' };
    const first = ledger.hold(input);
    expect(ledger.hold(input)).toEqual(first);
    expect(ledger.balance().held).toBe(11);
    expect(code(() => ledger.hold({ ...input, runId: 'run_2' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(() => ledger.settle(first.jobs[0]!.jobId, 1, 'h1'))).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('settle and release', () => {
  it('settles at most the hold, returns the rest, and closes the job once', () => {
    const { ledger, store } = member('plus');
    const q = ledger.quote([video('a')], catalog);
    const job = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }).jobs[0]!;
    const s = ledger.settle(job.jobId, 9999, 's1');
    expect(s).toMatchObject({ spent: 347, returned: 0, clamped: true, balance: { plan: 453, held: 0 } });
    expect(ledger.settle(job.jobId, 9999, 's1')).toEqual(s);
    expect(code(() => ledger.settle(job.jobId, 10, 's2'))).toBe('JOB_CLOSED');
    expect(code(() => ledger.release(job.jobId, 'failed', 'r1'))).toBe('JOB_CLOSED');
    expect(store.getMemberSpent('u1', '2026-11')).toBe(347);
  });

  it('partial settle returns the unspent part (purchased first)', () => {
    const { ledger } = member('starter');
    ledger.purchase(1000, 'pi', 'p');
    const q = ledger.quote([video('a')], catalog);
    const job = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }).jobs[0]!;
    // 200 from plan, 147 from purchased; spending 250 uses all plan and 50 purchased.
    const s = ledger.settle(job.jobId, 250, 's1');
    expect(s).toMatchObject({ spent: 250, returned: 97, balance: { plan: 0, purchased: 950, held: 0 } });
  });

  it('release refunds the whole hold with a refund line', () => {
    const { ledger, store } = member();
    const q = ledger.quote([video('a')], catalog);
    const job = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }).jobs[0]!;
    const r = ledger.release(job.jobId, 'provider_failed', 'r1');
    expect(r).toMatchObject({ refunded: 347, balance: { plan: 800, held: 0 } });
    const refund = store.allLines().filter((l) => l.kind === 'refund');
    expect(refund).toMatchObject([{ bucket: 'plan', amount: 347, jobId: job.jobId, note: 'provider_failed' }]);
    expect(code(() => ledger.release('job_missing', 'x', 'r2'))).toBe('NOT_FOUND');
  });

  it('returned plan credits from an expired period expire at once', () => {
    const { ledger, clock } = member('plus');
    const q = ledger.quote([video('a')], catalog);
    const job = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }).jobs[0]!;
    clock.now = addMonths(T0, 1) + DAY;
    const r = ledger.release(job.jobId, 'timeout', 'r1');
    expect(r.refunded).toBe(347);
    expect(r.balance).toMatchObject({ plan: 0, purchased: 0, held: 0 });
  });
});

describe('grant, purchase, expire', () => {
  it('grant replaces leftover plan credits and sets the expiry', () => {
    const { ledger, store } = member('starter');
    const q = ledger.quote([image('a')], catalog);
    const job = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }).jobs[0]!;
    ledger.settle(job.jobId, 11, 's1');
    const next = addMonths(T0, 1);
    const g = ledger.grant({ planId: 'starter', interval: 'month', start: next, end: addMonths(T0, 2) }, 'inv_2');
    expect(g).toMatchObject({ granted: 200, expired: 189, planExpiresAt: addMonths(T0, 2) });
    expect(ledger.grant({ planId: 'starter', interval: 'month', start: next, end: addMonths(T0, 2) }, 'inv_2')).toEqual(g);
    expect(store.allLines().filter((l) => l.kind === 'grant')).toHaveLength(2);
  });

  it('ignores a grant for an older period', () => {
    const { ledger } = member('plus');
    const g = ledger.grant({ planId: 'starter', interval: 'month', start: T0 - 30 * DAY, end: T0 }, 'inv_old');
    expect(g.skipped).toBe('stale');
    expect(ledger.balance().plan).toBe(800);
    expect(ledger.account().planId).toBe('plus');
  });

  it('purchased credits never expire; plan credits expire at period end', () => {
    const { ledger, clock } = member('plus');
    ledger.purchase(2600, 'pi_1', 'topup:pi_1');
    expect(ledger.purchase(2600, 'pi_1', 'topup:pi_1').balance.purchased).toBe(2600);
    clock.now = addMonths(T0, 1);
    expect(ledger.expire()).toMatchObject({ expired: 800, granted: 0, balance: { plan: 0, purchased: 2600, planExpiresAt: null } });
    expect(ledger.expire().expired).toBe(0);
  });

  it('yearly plans grant monthly slices until the period ends', () => {
    const { ledger, clock, store } = member('pro', 'year');
    expect(ledger.balance()).toMatchObject({ plan: 2500, planExpiresAt: addMonths(T0, 1) });
    clock.now = addMonths(T0, 1) + 5;
    expect(ledger.expire()).toMatchObject({ expired: 2500, granted: 2500, balance: { planExpiresAt: addMonths(T0, 2) } });
    // Lazy expiry: an operation after the slice end rolls it over first.
    clock.now = addMonths(T0, 2) + 5;
    expect(ledger.quote([image('a')], catalog).balance).toBe(2500);
    expect(store.allLines().filter((l) => l.kind === 'grant')).toHaveLength(3);
    clock.now = addMonths(T0, 12);
    expect(ledger.expire()).toMatchObject({ granted: 0, balance: { plan: 0 } });
  });

  it('cancelPlan expires plan credits and blocks new holds; purchased stay', () => {
    const { ledger } = member('plus');
    ledger.purchase(1000, 'pi', 'p');
    expect(ledger.cancelPlan('sub_del')).toMatchObject({ expired: 800, balance: { plan: 0, purchased: 1000 } });
    const q = ledger.quote([image('a')], catalog);
    expect(code(() => ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' }))).toBe('NO_PLAN');
  });

  it('auto top-up is due below the threshold, with a window that moves after a purchase', () => {
    const { ledger } = member('starter');
    expect(ledger.autoTopUpDue()).toBeNull();
    ledger.setAutoTopUp({ enabled: true, thresholdCredits: 250, amountCents: 1000 });
    const due = ledger.autoTopUpDue();
    expect(due).toMatchObject({ amountCents: 1000, available: 200 });
    expect(ledger.autoTopUpDue()?.window).toBe(due!.window);
    ledger.purchase(1000, 'pi_auto', 'auto:pi_auto', 'auto');
    expect(ledger.autoTopUpDue()).toBeNull();
    expect(code(() => ledger.setAutoTopUp({ enabled: true, thresholdCredits: 200, amountCents: 999 }))).toBe('BAD_REQUEST');
  });
});

describe('reconcile', () => {
  it('rebuilds balances from ledger lines', () => {
    const { ledger, store } = member('plus');
    ledger.purchase(1000, 'pi', 'p');
    const q = ledger.quote([video('a'), video('b', '480p')], catalog);
    const h = ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'u1', idemKey: 'h1' });
    ledger.settle(h.jobs[0]!.jobId, 300, 's1');
    const r = reconcile(store.allLines());
    const b = ledger.balance();
    expect(r).toEqual({ plan: b.plan, purchased: b.purchased, held: b.held, spent: 300 });
    expect(b.held).toBe(162);
  });
});
