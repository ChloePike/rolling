import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { addMonths, reconcile } from './ledger';
import { makeLedger } from './testkit';
import { LedgerError } from './types';

const catalog = fixtureCatalog.models;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const image = (ref: string) => ({ ref, modelId: 'bytedance/seedream-5.0-lite', request: { n: 1 } });

function team(seats: number, interval: 'month' | 'year' = 'month') {
  const t = makeLedger(T0);
  const end = interval === 'month' ? addMonths(T0, 1) : addMonths(T0, 12);
  t.ledger.grant({ planId: 'team', interval, start: T0, end, seats }, 'inv_team_1');
  return { ...t, end };
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

describe('Team grants and limits (D-013)', () => {
  it('grants 2,500 + 500 per extra seat each month slice', () => {
    expect(team(1).ledger.balance().plan).toBe(2500);
    const { ledger, clock, end } = team(4, 'year');
    expect(ledger.balance().plan).toBe(4000);
    clock.now = addMonths(T0, 1) + 1;
    ledger.expire();
    expect(ledger.balance()).toMatchObject({ plan: 4000, planExpiresAt: addMonths(T0, 2) });
    expect(end).toBe(addMonths(T0, 12));
  });

  it('allows 10 jobs at once plus 2 per extra seat', () => {
    const { ledger } = team(2);
    const items = Array.from({ length: 15 }, (_, i) => image(`n${i}`));
    const q = ledger.quote(items, catalog);
    const err = (() => {
      try {
        ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'usr_1', idemKey: 'h1' });
      } catch (e) {
        return e as LedgerError;
      }
      return null;
    })();
    expect(err?.code).toBe('CONCURRENCY_LIMIT');
    expect(err?.data).toMatchObject({ limit: 12 });
    ledger.setSeats(3, 'seats:3');
    expect(ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'usr_1', idemKey: 'h2', refs: items.slice(0, 14).map((i) => i.ref) }).jobs).toHaveLength(14);
  });

  it('grants the prorated share of added seats once per slice, idempotently', () => {
    const { ledger, clock, store } = team(1);
    const sliceEnd = addMonths(T0, 1);
    clock.now = T0 + (sliceEnd - T0) / 2;
    const r = ledger.setSeats(3, 'evt_add_2');
    expect(r).toMatchObject({ seats: 3, previous: 1, granted: 500 });
    expect(ledger.balance().plan).toBe(3000);
    // Replays (webhook retries, the PATCH response and the webhook) grant nothing new.
    expect(ledger.setSeats(3, 'evt_add_2').granted).toBe(500);
    expect(ledger.setSeats(3, 'evt_other').granted).toBe(0);
    // Remove a seat and add it back in the same slice: no second grant.
    expect(ledger.setSeats(2, 'evt_remove').granted).toBe(0);
    expect(ledger.setSeats(3, 'evt_readd').granted).toBe(0);
    expect(ledger.balance().plan).toBe(3000);
    // One seat above the high-water mark is granted.
    expect(ledger.setSeats(4, 'evt_add_1').granted).toBe(250);
    expect(ledger.account()).toMatchObject({ seats: 4, sliceSeats: 4 });
    // The next period grants the full amount for the seats held then.
    clock.now = sliceEnd + 1;
    ledger.grant({ planId: 'team', interval: 'month', start: sliceEnd, end: addMonths(sliceEnd, 1) }, 'inv_team_2');
    expect(ledger.balance().plan).toBe(4000);
    const sums = reconcile(store.allLines());
    expect(sums.plan).toBe(ledger.balance().plan);
  });

  it('does not grant for added seats on personal plans or without a live slice', () => {
    const t = makeLedger(T0);
    t.ledger.grant({ planId: 'pro', interval: 'month', start: T0, end: addMonths(T0, 1) }, 'inv_pro');
    expect(t.ledger.setSeats(3, 's1')).toMatchObject({ granted: 0 });
    expect(t.ledger.balance().plan).toBe(2500);
    const none = makeLedger(T0);
    expect(none.ledger.setSeats(2, 's2').granted).toBe(0);
    expect(none.ledger.balance().plan).toBe(0);
  });

  it('switching a personal plan to Team grants the Team amount for the seats', () => {
    const t = makeLedger(T0);
    t.ledger.grant({ planId: 'plus', interval: 'month', start: T0, end: addMonths(T0, 1) }, 'inv_plus');
    t.clock.now = T0 + 3 * DAY;
    // customer.subscription.updated may land first: limits move, no seat credits on a Plus slice.
    t.ledger.setPlan('team');
    expect(t.ledger.setSeats(2, 'evt_upd').granted).toBe(0);
    expect(t.ledger.account().grantedPlanId).toBe('plus');
    t.ledger.grant({ planId: 'team', interval: 'month', start: T0, end: addMonths(T0, 1), seats: 2 }, 'inv_switch');
    expect(t.ledger.balance().plan).toBe(3000);
    expect(t.ledger.account()).toMatchObject({ planId: 'team', seats: 2, sliceSeats: 2, grantedPlanId: 'team' });
  });

  it('validates seat counts', () => {
    const { ledger } = team(1);
    expect(code(() => ledger.setSeats(0, 'bad0'))).toBe('BAD_REQUEST');
    expect(code(() => ledger.setSeats(2.5, 'bad1'))).toBe('BAD_REQUEST');
    expect(code(() => ledger.grant({ planId: 'team', interval: 'month', start: T0, end: T0 + DAY, seats: 0 }, 'bad2'))).toBe('BAD_REQUEST');
  });
});
