/**
 * The credit ledger: the only code that changes balances (CLAUDE.md "Credits
 * are money"). Synchronous and storage-agnostic; every mutating operation runs
 * inside `store.transaction` and is idempotent by key (a repeat with the same
 * key and arguments returns the first result; failed operations change nothing
 * and are not recorded, so they may be retried).
 *
 * Invariants (checked by the property tests):
 * - `plan`, `purchased`, `held` are never negative and `held` equals the sum of open holds;
 * - a settle never spends more than its hold; a job is settled or released at most once;
 * - the buckets equal the sums of their ledger lines (see `reconcile`).
 */
import { creditsFor, lowestPlanFor, planAllowsResolution, PLANS, TOP_UP, UnpricedModelError, type PlanId } from '../pricing/config';
import type {
  AccountState,
  AutoTopUpSettings,
  Balance,
  Bucket,
  ExpireResult,
  GrantPeriod,
  GrantResult,
  HeldJob,
  HoldInput,
  HoldRecord,
  HoldResult,
  IdemRecord,
  LedgerKind,
  LedgerLine,
  ListingModel,
  PurchaseResult,
  QuoteItemInput,
  QuoteResult,
  QuotedItem,
  ReleaseResult,
  SettleResult,
  StoredQuote,
} from './types';
import { LedgerError } from './types';

/** Quotes are valid for 10 minutes (architecture §5). */
export const QUOTE_TTL_MS = 10 * 60 * 1000;
/** Once a run has held part of a quote, the rest of it may be held by that run for this long. */
export const RUN_QUOTE_TTL_MS = 24 * 60 * 60 * 1000;
/** Renewal invoices can land a little after the period ends; holds stay allowed meanwhile. */
export const PLAN_GRACE_MS = 60 * 60 * 1000;

export interface LedgerStore {
  transaction<T>(fn: () => T): T;
  getAccount(): AccountState;
  putAccount(state: AccountState): void;
  getQuote(id: string): StoredQuote | null;
  putQuote(quote: StoredQuote): void;
  getHold(jobId: string): HoldRecord | null;
  putHold(hold: HoldRecord): void;
  openHolds(): HoldRecord[];
  holdsForQuote(quoteId: string): HoldRecord[];
  getMemberSpent(userId: string, month: string): number;
  addMemberSpent(userId: string, month: string, amount: number): void;
  getIdem(key: string): IdemRecord | null;
  putIdem(record: IdemRecord): void;
  appendLines(lines: LedgerLine[]): void;
}

export interface LedgerDeps {
  now(): number;
  newId(kind: 'quote' | 'job' | 'ledger'): string;
}

export function emptyAccount(): AccountState {
  return {
    plan: 0,
    purchased: 0,
    held: 0,
    planExpiresAt: null,
    planId: null,
    interval: null,
    periodStart: null,
    periodEnd: null,
    autoTopUp: null,
    autoTopUpSeq: 0,
  };
}

export function balanceOf(s: AccountState): Balance {
  return { plan: s.plan, purchased: s.purchased, held: s.held, planExpiresAt: s.planExpiresAt };
}

/** UTC `YYYY-MM` for member monthly limits. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Adds calendar months in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function requireKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new LedgerError('BAD_REQUEST', 'An idempotency key is required.');
  }
  return key;
}

export class CreditLedger {
  constructor(
    private readonly store: LedgerStore,
    private readonly deps: LedgerDeps,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  balance(): Balance {
    return balanceOf(this.store.getAccount());
  }

  account(): AccountState {
    return this.store.getAccount();
  }

  /**
   * Auto top-up that should run now, if any: enabled, a plan, and available
   * credits below the threshold. `window` is stable until the next auto top-up
   * purchase or settings change, so the workflow instance id dedupes triggers.
   */
  autoTopUpDue(): { window: string; amountCents: number; available: number } | null {
    const s = this.store.getAccount();
    const a = s.autoTopUp;
    if (!a?.enabled || !s.planId) return null;
    const available = s.plan + s.purchased;
    if (available >= a.thresholdCredits) return null;
    return { window: `${s.periodStart ?? 0}-${s.autoTopUpSeq}`, amountCents: a.amountCents, available };
  }

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  /** Prices items over the caller's synced catalog and stores the quote for 10 minutes. */
  quote(items: readonly QuoteItemInput[], catalog: readonly ListingModel[]): QuoteResult {
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
      throw new LedgerError('BAD_REQUEST', 'A quote needs 1 to 200 items.');
    }
    const refs = new Set<string>();
    for (const it of items) {
      if (typeof it.ref !== 'string' || it.ref.length === 0) throw new LedgerError('BAD_REQUEST', 'Every item needs a ref.');
      if (refs.has(it.ref)) throw new LedgerError('BAD_REQUEST', 'Item refs must be unique.', { ref: it.ref });
      refs.add(it.ref);
    }
    const byId = new Map(catalog.map((m) => [m.id, m]));
    return this.store.transaction(() => {
      const now = this.deps.now();
      this.tickInTx(now);
      const s = this.store.getAccount();
      const priced: QuotedItem[] = items.map((it) => this.priceItem(it, byId.get(it.modelId), s.planId));
      const ok = priced.filter((p) => !p.blocked);
      const total = ok.reduce((sum, p) => sum + p.credits, 0);
      const quote: StoredQuote = {
        id: this.deps.newId('quote'),
        items: ok,
        total,
        createdAt: now,
        expiresAt: now + QUOTE_TTL_MS,
        runId: null,
      };
      this.store.putQuote(quote);
      const available = s.plan + s.purchased;
      return { quoteId: quote.id, items: priced, total, balance: available, balanceAfter: available - total, expiresAt: quote.expiresAt };
    });
  }

  private priceItem(it: QuoteItemInput, model: ListingModel | undefined, planId: PlanId | null): QuotedItem {
    const base = { ref: it.ref, modelId: it.modelId, credits: 0 };
    if (!model || (model.kind !== 'video' && model.kind !== 'image')) return { ...base, blocked: 'unknown_model' };
    const resolution = it.request?.resolution ?? model.defaultResolution;
    if (planId && resolution && !planAllowsResolution(planId, model.kind, resolution)) {
      return { ...base, blocked: 'resolution_locked', lowestPlan: lowestPlanFor(model.kind, resolution) };
    }
    try {
      return { ...base, credits: creditsFor(model, it.request ?? {}) };
    } catch (e) {
      if (e instanceof UnpricedModelError || e instanceof RangeError) return { ...base, blocked: 'unpriced' };
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Hold / settle / release
  // -------------------------------------------------------------------------

  hold(input: HoldInput): HoldResult {
    const key = requireKey(input.idemKey);
    if (!input.quoteId || !input.runId || !input.userId) throw new LedgerError('BAD_REQUEST', 'quoteId, runId and userId are required.');
    if (input.memberMonthlyLimit != null && !isNonNegInt(input.memberMonthlyLimit)) {
      throw new LedgerError('BAD_REQUEST', 'memberMonthlyLimit must be a non-negative integer.');
    }
    return this.idempotent('hold', key, input, (now) => {
      const quote = this.store.getQuote(input.quoteId);
      if (!quote) throw new LedgerError('NOT_FOUND', 'Quote not found.', { quoteId: input.quoteId });
      if (quote.runId && quote.runId !== input.runId) {
        throw new LedgerError('BAD_REQUEST', 'Quote is already used by another run.', { quoteId: quote.id });
      }
      const deadline = quote.runId ? quote.expiresAt + RUN_QUOTE_TTL_MS : quote.expiresAt;
      if (now >= deadline) throw new LedgerError('QUOTE_EXPIRED', 'Quote expired.', { quoteId: quote.id, expiresAt: quote.expiresAt });

      const s = this.store.getAccount();
      if (!s.planId || (s.periodEnd !== null && now >= s.periodEnd + PLAN_GRACE_MS)) {
        throw new LedgerError('NO_PLAN', 'An active plan is required.');
      }

      const already = new Set(this.store.holdsForQuote(quote.id).map((h) => h.itemRef));
      let items = quote.items;
      if (input.refs) {
        const wanted = new Set(input.refs);
        const known = new Set(quote.items.map((i) => i.ref));
        for (const r of wanted) if (!known.has(r)) throw new LedgerError('BAD_REQUEST', 'Unknown quote item.', { ref: r });
        items = items.filter((i) => wanted.has(i.ref));
      }
      items = items.filter((i) => !already.has(i.ref));
      const total = items.reduce((sum, i) => sum + i.credits, 0);

      const open = this.store.openHolds();
      const limit = PLANS[s.planId].concurrentJobs;
      if (items.length > 0 && open.length + items.length > limit) {
        throw new LedgerError('CONCURRENCY_LIMIT', 'Too many jobs running at once for this plan.', {
          limit,
          active: open.length,
          requested: items.length,
        });
      }

      if (input.memberMonthlyLimit != null) {
        const month = monthKey(now);
        const openForUser = open.filter((h) => h.userId === input.userId).reduce((sum, h) => sum + h.credits, 0);
        const used = this.store.getMemberSpent(input.userId, month) + openForUser;
        if (used + total > input.memberMonthlyLimit) {
          throw new LedgerError('MEMBER_LIMIT_REACHED', 'Monthly credit limit for this member is used.', {
            limit: input.memberMonthlyLimit,
            used,
            needed: total,
          });
        }
      }

      const available = s.plan + s.purchased;
      if (total > available) {
        throw new LedgerError('INSUFFICIENT_CREDITS', 'Not enough credits.', { needed: total, balance: available });
      }

      const lines: LedgerLine[] = [];
      const jobs: HeldJob[] = [];
      for (const item of items) {
        const fromPlan = Math.min(item.credits, s.plan);
        const fromPurchased = item.credits - fromPlan;
        s.plan -= fromPlan;
        s.purchased -= fromPurchased;
        s.held += item.credits;
        const jobId = this.deps.newId('job');
        const hold: HoldRecord = {
          jobId,
          quoteId: quote.id,
          itemRef: item.ref,
          modelId: item.modelId,
          runId: input.runId,
          userId: input.userId,
          credits: item.credits,
          fromPlan,
          fromPurchased,
          planExpiresAt: s.planExpiresAt,
          status: 'held',
          spent: null,
          createdAt: now,
          closedAt: null,
        };
        this.store.putHold(hold);
        const ctx = { userId: input.userId, runId: input.runId, jobId };
        if (fromPlan > 0 || item.credits === 0) lines.push(this.line(key, lines.length, 'hold', 'plan', 0 - fromPlan, now, ctx));
        if (fromPurchased > 0) lines.push(this.line(key, lines.length, 'hold', 'purchased', 0 - fromPurchased, now, ctx));
        jobs.push({ jobId, ref: item.ref, modelId: item.modelId, credits: item.credits });
      }
      if (!quote.runId) this.store.putQuote({ ...quote, runId: input.runId });
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { quoteId: quote.id, runId: input.runId, jobs, total, balance: balanceOf(s) };
    });
  }

  /** Spends `actual` (capped at the hold) and returns the rest of the job's hold. */
  settle(jobId: string, actual: number, idemKey: string): SettleResult {
    const key = requireKey(idemKey);
    if (!isNonNegInt(actual)) throw new LedgerError('BAD_REQUEST', 'actual must be a non-negative integer.');
    return this.idempotent('settle', key, { jobId, actual }, (now) => {
      const hold = this.openHold(jobId);
      const spent = Math.min(actual, hold.credits);
      const spentPlan = Math.min(spent, hold.fromPlan);
      const spentPurchased = spent - spentPlan;
      const lines: LedgerLine[] = [];
      const ctx = { userId: hold.userId, runId: hold.runId, jobId };
      if (spentPlan > 0 || spent === 0) lines.push(this.line(key, lines.length, 'settle', 'plan', 0 - spentPlan, now, ctx));
      if (spentPurchased > 0) lines.push(this.line(key, lines.length, 'settle', 'purchased', 0 - spentPurchased, now, ctx));
      const s = this.store.getAccount();
      const returned = this.returnToBuckets(s, hold, hold.fromPlan - spentPlan, hold.fromPurchased - spentPurchased, 'release', key, lines, now, null);
      s.held -= hold.credits;
      if (spent > 0) this.store.addMemberSpent(hold.userId, monthKey(now), spent);
      this.store.putHold({ ...hold, status: 'settled', spent, closedAt: now });
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { jobId, spent, returned, clamped: actual > hold.credits, balance: balanceOf(s) };
    });
  }

  /** Returns the whole hold as a refund (failure, cancel, safety block). */
  release(jobId: string, reason: string, idemKey: string): ReleaseResult {
    const key = requireKey(idemKey);
    const note = String(reason ?? '').slice(0, 200) || 'released';
    return this.idempotent('release', key, { jobId, reason: note }, (now) => {
      const hold = this.openHold(jobId);
      const lines: LedgerLine[] = [];
      const s = this.store.getAccount();
      const refunded = this.returnToBuckets(s, hold, hold.fromPlan, hold.fromPurchased, 'refund', key, lines, now, note);
      s.held -= hold.credits;
      this.store.putHold({ ...hold, status: 'released', spent: 0, closedAt: now });
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { jobId, refunded, balance: balanceOf(s) };
    });
  }

  private openHold(jobId: string): HoldRecord {
    const hold = this.store.getHold(jobId);
    if (!hold) throw new LedgerError('NOT_FOUND', 'No hold for this job.', { jobId });
    if (hold.status !== 'held') throw new LedgerError('JOB_CLOSED', 'This job was already settled or released.', { jobId, status: hold.status });
    return hold;
  }

  /**
   * Returns unspent credits of a hold. Plan credits from a slice that has since
   * expired or been replaced are returned and expired at once, so a refund
   * never revives credits past their expiry.
   */
  private returnToBuckets(
    s: AccountState,
    hold: HoldRecord,
    plan: number,
    purchased: number,
    kind: 'release' | 'refund',
    key: string,
    lines: LedgerLine[],
    now: number,
    note: string | null,
  ): number {
    const ctx = { userId: hold.userId, runId: hold.runId, jobId: hold.jobId, note };
    if (plan > 0) {
      lines.push(this.line(key, lines.length, kind, 'plan', plan, now, ctx));
      const sliceAlive = s.planExpiresAt !== null && s.planExpiresAt === hold.planExpiresAt && now < s.planExpiresAt;
      if (sliceAlive) s.plan += plan;
      else lines.push(this.line(key, lines.length, 'expire', 'plan', 0 - plan, now, { ...ctx, note: 'plan period ended' }));
    }
    if (purchased > 0) {
      lines.push(this.line(key, lines.length, kind, 'purchased', purchased, now, ctx));
      s.purchased += purchased;
    }
    return plan + purchased;
  }

  // -------------------------------------------------------------------------
  // Grants, purchases, expiry
  // -------------------------------------------------------------------------

  /**
   * Plan credits for a paid billing period (`invoice.paid`). Leftover plan
   * credits expire and are replaced. Monthly plans get the monthly amount until
   * the period end; yearly plans get it in monthly slices (the rest via `expire`).
   * A period older than the current one is ignored (out-of-order webhooks).
   */
  grant(period: GrantPeriod, idemKey: string): GrantResult {
    const key = requireKey(idemKey);
    if (!PLANS[period.planId]) throw new LedgerError('BAD_REQUEST', 'Unknown plan.', { planId: period.planId });
    if (period.interval !== 'month' && period.interval !== 'year') throw new LedgerError('BAD_REQUEST', 'Unknown interval.');
    if (!isNonNegInt(period.start) || !isNonNegInt(period.end) || period.end <= period.start) {
      throw new LedgerError('BAD_REQUEST', 'Invalid period.');
    }
    return this.idempotent('grant', key, period, (now) => {
      const s = this.store.getAccount();
      if (s.periodStart !== null && period.start < s.periodStart) {
        return { granted: 0, expired: 0, planExpiresAt: s.planExpiresAt, skipped: 'stale' as const, balance: balanceOf(s) };
      }
      s.planId = period.planId;
      s.interval = period.interval;
      if (s.periodStart !== period.start) s.autoTopUpSeq += 1;
      s.periodStart = period.start;
      s.periodEnd = period.end;
      const lines: LedgerLine[] = [];
      const { expired, granted } = this.replacePlanCredits(s, now, key, lines);
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { granted, expired, planExpiresAt: s.planExpiresAt, balance: balanceOf(s) };
    });
  }

  /** Expires leftover plan credits and grants the slice of the period that contains `now`. */
  private replacePlanCredits(s: AccountState, now: number, key: string, lines: LedgerLine[]): { expired: number; granted: number } {
    const expired = s.plan;
    if (expired > 0) lines.push(this.line(key, lines.length, 'expire', 'plan', 0 - expired, now, {}));
    s.plan = 0;
    s.planExpiresAt = null;
    if (!s.planId || s.periodStart === null || s.periodEnd === null || now >= s.periodEnd) return { expired, granted: 0 };
    let sliceEnd = s.periodEnd;
    if (s.interval === 'year') {
      let k = 1;
      while (addMonths(s.periodStart, k) <= now) k += 1;
      sliceEnd = Math.min(addMonths(s.periodStart, k), s.periodEnd);
    }
    const granted = PLANS[s.planId].monthlyCredits;
    s.plan = granted;
    s.planExpiresAt = sliceEnd;
    lines.push(this.line(key, lines.length, 'grant', 'plan', granted, now, { note: `${s.planId}:${s.interval}` }));
    return { expired, granted };
  }

  /** Purchased credits (top-up). Never expire. `source: 'auto'` advances the auto top-up window. */
  purchase(credits: number, ref: string, idemKey: string, source: 'checkout' | 'auto' = 'checkout'): PurchaseResult {
    const key = requireKey(idemKey);
    if (!isNonNegInt(credits) || credits === 0) throw new LedgerError('BAD_REQUEST', 'credits must be a positive integer.');
    if (typeof ref !== 'string' || !ref) throw new LedgerError('BAD_REQUEST', 'A payment reference is required.');
    return this.idempotent('purchase', key, { credits, ref, source }, (now) => {
      const s = this.store.getAccount();
      s.purchased += credits;
      if (source === 'auto') s.autoTopUpSeq += 1;
      const lines = [this.line(key, 0, 'purchase', 'purchased', credits, now, { stripeRef: ref, note: source })];
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { credits, balance: balanceOf(s) };
    });
  }

  /**
   * Period-end processing (DO alarm, and lazily before every operation):
   * expires plan credits whose slice ended and, for yearly plans, grants the
   * next monthly slice. Idempotent by the slice it closes.
   */
  expire(): ExpireResult {
    return this.store.transaction(() => {
      const r = this.tickInTx(this.deps.now());
      return { ...r, balance: balanceOf(this.store.getAccount()) };
    });
  }

  /** Next time `expire` has work to do (for the DO alarm). */
  nextExpiry(): number | null {
    return this.store.getAccount().planExpiresAt;
  }

  private tickInTx(now: number): { expired: number; granted: number } {
    const s = this.store.getAccount();
    if (s.planExpiresAt === null || now < s.planExpiresAt) return { expired: 0, granted: 0 };
    const key = `expire:${s.planExpiresAt}`;
    if (this.store.getIdem(key)) return { expired: 0, granted: 0 };
    const lines: LedgerLine[] = [];
    const r = this.replacePlanCredits(s, now, key, lines);
    this.store.putAccount(s);
    this.store.appendLines(lines);
    this.store.putIdem({ key, op: 'expire', fingerprint: '', result: r, createdAt: now });
    return r;
  }

  /** Subscription ended (`customer.subscription.deleted`): plan credits expire now; purchased stay. */
  cancelPlan(idemKey: string): ExpireResult {
    const key = requireKey(idemKey);
    return this.idempotent('cancelPlan', key, {}, (now) => {
      const s = this.store.getAccount();
      const lines: LedgerLine[] = [];
      const expired = s.plan;
      if (expired > 0) lines.push(this.line(key, 0, 'expire', 'plan', 0 - expired, now, { note: 'subscription ended' }));
      s.plan = 0;
      s.planExpiresAt = null;
      s.planId = null;
      s.interval = null;
      s.periodEnd = null;
      this.store.putAccount(s);
      this.store.appendLines(lines);
      return { expired, granted: 0, balance: balanceOf(s) };
    });
  }

  /** Plan change without an invoice (e.g. a scheduled downgrade): limits follow the new plan. */
  setPlan(planId: PlanId): Balance {
    if (!PLANS[planId]) throw new LedgerError('BAD_REQUEST', 'Unknown plan.', { planId });
    return this.store.transaction(() => {
      const s = this.store.getAccount();
      if (s.planId !== null) s.planId = planId;
      this.store.putAccount(s);
      return balanceOf(s);
    });
  }

  setAutoTopUp(settings: AutoTopUpSettings): AutoTopUpSettings {
    if (typeof settings.enabled !== 'boolean') throw new LedgerError('BAD_REQUEST', 'enabled must be a boolean.');
    if (!isNonNegInt(settings.thresholdCredits) || settings.thresholdCredits > 1_000_000) {
      throw new LedgerError('BAD_REQUEST', 'thresholdCredits must be a non-negative integer.');
    }
    if (!isNonNegInt(settings.amountCents) || settings.amountCents < TOP_UP.minUsd * 100 || settings.amountCents > TOP_UP.maxUsd * 100) {
      throw new LedgerError('BAD_REQUEST', 'amountCents is outside the top-up limits.', { min: TOP_UP.minUsd * 100, max: TOP_UP.maxUsd * 100 });
    }
    return this.store.transaction(() => {
      const s = this.store.getAccount();
      s.autoTopUp = { enabled: settings.enabled, thresholdCredits: settings.thresholdCredits, amountCents: settings.amountCents };
      s.autoTopUpSeq += 1;
      this.store.putAccount(s);
      return s.autoTopUp;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
      this.tickInTx(now);
      const result = fn(now);
      this.store.putIdem({ key, op, fingerprint, result, createdAt: now });
      return result;
    });
  }

  private line(
    key: string,
    index: number,
    kind: LedgerKind,
    bucket: Bucket,
    amount: number,
    now: number,
    ctx: { userId?: string | null; runId?: string | null; jobId?: string | null; stripeRef?: string | null; note?: string | null },
  ): LedgerLine {
    return {
      id: this.deps.newId('ledger'),
      kind,
      bucket,
      amount,
      userId: ctx.userId ?? null,
      runId: ctx.runId ?? null,
      jobId: ctx.jobId ?? null,
      stripeRef: ctx.stripeRef ?? null,
      idemKey: `${key}#${index}`,
      note: ctx.note ?? null,
      createdAt: now,
    };
  }
}

/**
 * Recomputes balances from ledger lines (nightly reconcile and tests):
 * available buckets are the sums of every non-settle line; `held` is what
 * holds took minus what settles spent and releases/refunds returned.
 */
export function reconcile(lines: readonly Pick<LedgerLine, 'kind' | 'bucket' | 'amount'>[]): { plan: number; purchased: number; held: number; spent: number } {
  let plan = 0;
  let purchased = 0;
  let held = 0;
  let spent = 0;
  for (const l of lines) {
    if (l.kind !== 'settle') {
      if (l.bucket === 'plan') plan += l.amount;
      else purchased += l.amount;
    }
    if (l.kind === 'hold') held -= l.amount;
    else if (l.kind === 'settle') {
      held += l.amount;
      spent -= l.amount;
    } else if (l.kind === 'release' || l.kind === 'refund') held -= l.amount;
  }
  return { plan, purchased, held, spent };
}
