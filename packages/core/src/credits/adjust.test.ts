import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { addMonths, reconcile } from './ledger';
import { makeLedger } from './testkit';
import { LedgerError } from './types';

const T0 = Date.UTC(2026, 10, 1);
const catalog = fixtureCatalog.models;

function member() {
  const t = makeLedger(T0);
  t.ledger.grant({ planId: 'plus', interval: 'month', start: T0, end: addMonths(T0, 1) }, 'inv_1');
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

function settledJob(t: ReturnType<typeof member>) {
  const q = t.ledger.quote([{ ref: 'n1', modelId: 'bytedance/seedream-5.0-lite', request: { n: 1 } }], catalog);
  const h = t.ledger.hold({ quoteId: q.quoteId, runId: 'run_1', userId: 'usr_1', idemKey: 'hold:1' });
  const job = h.jobs[0]!;
  t.ledger.settle(job.jobId, job.credits, `settle:${job.jobId}`);
  return job;
}

describe('staff adjustments (D-025)', () => {
  it('grants purchased credits and deducts purchased first, then plan, never below zero', () => {
    const t = member();
    expect(t.ledger.adjust({ amount: 500, reason: 'Goodwill', actor: 'usr_admin', idemKey: 'a1' }).balance).toMatchObject({ plan: 800, purchased: 500 });
    // Same key, same request: the first result.
    expect(t.ledger.adjust({ amount: 500, reason: 'Goodwill', actor: 'usr_admin', idemKey: 'a1' }).balance.purchased).toBe(500);
    expect(code(() => t.ledger.adjust({ amount: 400, reason: 'Other', actor: 'usr_admin', idemKey: 'a1' }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(t.ledger.adjust({ amount: -700, reason: 'Chargeback', actor: 'usr_admin', idemKey: 'a2' }).balance).toMatchObject({ plan: 600, purchased: 0 });
    expect(code(() => t.ledger.adjust({ amount: -601, reason: 'Too much', actor: 'usr_admin', idemKey: 'a3' }))).toBe('INSUFFICIENT_CREDITS');
    expect(code(() => t.ledger.adjust({ amount: 10, reason: ' ', actor: 'usr_admin', idemKey: 'a4' }))).toBe('BAD_REQUEST');
    expect(code(() => t.ledger.adjust({ amount: 0, reason: 'x', actor: 'usr_admin', idemKey: 'a5' }))).toBe('BAD_REQUEST');
    const lines = t.store.allLines().filter((l) => l.kind === 'adjust');
    expect(lines.map((l) => [l.bucket, l.amount])).toEqual([
      ['purchased', 500],
      ['purchased', -500],
      ['plan', -200],
    ]);
    expect(lines[0]!.note).toBe('staff:usr_admin:Goodwill');
    const b = t.ledger.balance();
    expect(reconcile(t.store.allLines())).toMatchObject({ plan: b.plan, purchased: b.purchased, held: b.held });
  });

  it('refunds a settled job once, as purchased credits, and refuses open or released jobs', () => {
    const t = member();
    const job = settledJob(t);
    const before = t.ledger.balance();
    const r = t.ledger.refundJob({ jobId: job.jobId, reason: 'Bad output', actor: 'usr_admin', idemKey: 'r1' });
    expect(r.refunded).toBe(job.credits);
    expect(r.balance.purchased).toBe(before.purchased + job.credits);
    // A retry with the same key replays; another key is refused (one refund per job).
    expect(t.ledger.refundJob({ jobId: job.jobId, reason: 'Bad output', actor: 'usr_admin', idemKey: 'r1' }).refunded).toBe(job.credits);
    expect(code(() => t.ledger.refundJob({ jobId: job.jobId, reason: 'Again', actor: 'usr_admin', idemKey: 'r2' }))).toBe('JOB_CLOSED');
    expect(code(() => t.ledger.refundJob({ jobId: 'job_missing', reason: 'x', actor: 'a', idemKey: 'r3' }))).toBe('NOT_FOUND');
    const q = t.ledger.quote([{ ref: 'n2', modelId: 'bytedance/seedream-5.0-lite', request: { n: 1 } }], catalog);
    const open = t.ledger.hold({ quoteId: q.quoteId, runId: 'run_2', userId: 'usr_1', idemKey: 'hold:2' }).jobs[0]!;
    expect(code(() => t.ledger.refundJob({ jobId: open.jobId, reason: 'x', actor: 'a', idemKey: 'r4' }))).toBe('JOB_CLOSED');
    const line = t.store.allLines().find((l) => l.kind === 'adjust')!;
    expect(line).toMatchObject({ runId: 'run_1', jobId: job.jobId, bucket: 'purchased', amount: job.credits });
    const b = t.ledger.balance();
    expect(reconcile(t.store.allLines())).toMatchObject({ plan: b.plan, purchased: b.purchased, held: b.held });
  });
});
