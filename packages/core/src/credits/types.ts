/**
 * Credit ledger types (docs/architecture.md §5, D-006). Pure data: the
 * `CreditLedger` works over a `LedgerStore`, which is an in-memory map in tests
 * and the CreditAccount Durable Object's SQLite in production.
 *
 * Bucket semantics: `plan` and `purchased` are AVAILABLE credits (not held);
 * `held` is the sum of open holds. A hold moves credits from the buckets into
 * `held`; settle spends at most the held amount and returns the rest; release
 * returns all of it as a refund.
 */
import type { ListingModel } from '../models/types';
import type { PriceRequest } from '../models/catalog';
import type { PlanId } from '../pricing/config';

/** `trial`: the one-time sign-up trial (D-022), spent first and expiring with the trial. */
export type Bucket = 'plan' | 'purchased' | 'trial';
export type LedgerKind = 'grant' | 'purchase' | 'hold' | 'settle' | 'release' | 'refund' | 'expire' | 'adjust';
export type PlanInterval = 'month' | 'year';

/**
 * One journal line. `amount` is signed:
 * - grant, purchase, release, refund: + into the bucket's available credits
 * - hold, expire: − out of the bucket's available credits (hold moves it into `held`)
 * - settle: − spent out of `held` (does not touch available credits)
 */
export interface LedgerLine {
  id: string;
  kind: LedgerKind;
  bucket: Bucket;
  amount: number;
  userId: string | null;
  runId: string | null;
  jobId: string | null;
  stripeRef: string | null;
  /** `<operation idempotency key>#<index>`; unique per line. */
  idemKey: string;
  note: string | null;
  createdAt: number;
}

export interface AutoTopUpSettings {
  enabled: boolean;
  /** Start a top-up when available credits fall below this. */
  thresholdCredits: number;
  /** Amount charged off-session (whole cents, TOP_UP bounds). */
  amountCents: number;
}

export interface AccountState {
  plan: number;
  purchased: number;
  held: number;
  /** When the current plan credits expire (end of the month slice). */
  planExpiresAt: number | null;
  planId: PlanId | null;
  interval: PlanInterval | null;
  /** Stripe billing period of the subscription (yearly plans grant monthly slices inside it). */
  periodStart: number | null;
  periodEnd: number | null;
  autoTopUp: AutoTopUpSettings | null;
  /** Bumped by every auto top-up purchase and settings change; part of the workflow window id. */
  autoTopUpSeq: number;
  /** Purchased seats (D-013; Team only, 1 for personal plans). Drives Team grants and concurrency. */
  seats: number;
  /** Highest seat count already granted plan credits in the current slice (added seats are granted once). */
  sliceSeats: number;
  /** Plan the current slice's credits were granted for; a paid change to a higher plan is an upgrade (grants again). */
  grantedPlanId: PlanId | null;
  /** Available trial credits (D-022). */
  trial: number;
  /** When the trial ends (its credits expire); null when never granted. */
  trialExpiresAt: number | null;
  /** When the trial was granted (once per workspace); null when never. */
  trialGrantedAt: number | null;
}

export interface Balance {
  plan: number;
  purchased: number;
  held: number;
  planExpiresAt: number | null;
  /** Trial credits (D-022); present only once a trial was granted. */
  trial?: number;
  trialExpiresAt?: number | null;
}

export interface QuoteItemInput {
  /** Caller's key for the item (e.g. node id). Unique within one quote. */
  ref: string;
  modelId: string;
  request?: PriceRequest;
}

export type QuoteBlockReason = 'unknown_model' | 'unpriced' | 'resolution_locked' | 'trial_locked';

export interface QuotedItem {
  ref: string;
  modelId: string;
  credits: number;
  blocked?: QuoteBlockReason;
  /** For `resolution_locked` / `trial_locked`: the lowest plan that allows the request. */
  lowestPlan?: PlanId | null;
  /** For `trial_locked`: which trial cap the request is over (D-022). */
  trialLock?: 'model' | 'resolution' | 'duration' | 'count';
}

export interface StoredQuote {
  id: string;
  /** Priced (non-blocked) items only. */
  items: QuotedItem[];
  total: number;
  createdAt: number;
  expiresAt: number;
  /** Bound on first hold; later holds of remaining items must use the same run. */
  runId: string | null;
  /** Priced under the trial rules (no plan, active trial, D-022); only such quotes may be held without a plan. */
  trial?: boolean;
}

export interface QuoteResult {
  quoteId: string;
  items: QuotedItem[];
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number;
  /** Priced under the trial rules (D-022). */
  trial?: boolean;
}

export type HoldStatus = 'held' | 'settled' | 'released';

export interface HoldRecord {
  jobId: string;
  quoteId: string;
  itemRef: string;
  modelId: string;
  runId: string;
  userId: string;
  credits: number;
  fromPlan: number;
  fromPurchased: number;
  /** Taken from the trial bucket (D-022); returned trial credits expire once the trial has ended. */
  fromTrial?: number;
  /** `planExpiresAt` when the hold was taken: returned plan credits from an ended slice expire. */
  planExpiresAt: number | null;
  status: HoldStatus;
  spent: number | null;
  createdAt: number;
  closedAt: number | null;
}

export interface HoldInput {
  quoteId: string;
  runId: string;
  userId: string;
  idemKey: string;
  /** Hold only these quote items (default: every item not held yet). */
  refs?: string[];
  /** The member's monthly credit limit from `workspace_members` (null/undefined = no limit). */
  memberMonthlyLimit?: number | null;
}

export interface HeldJob {
  jobId: string;
  ref: string;
  modelId: string;
  credits: number;
}

export interface HoldResult {
  quoteId: string;
  runId: string;
  jobs: HeldJob[];
  total: number;
  balance: Balance;
}

export interface SettleResult {
  jobId: string;
  spent: number;
  returned: number;
  /** `actual` was above the hold; the charge was capped at the hold. */
  clamped: boolean;
  balance: Balance;
}

export interface ReleaseResult {
  jobId: string;
  refunded: number;
  balance: Balance;
}

export interface GrantPeriod {
  planId: PlanId;
  interval: PlanInterval;
  /** Billing period from Stripe (epoch ms). */
  start: number;
  end: number;
  /** Purchased seats (Team, D-013); omitted keeps the stored count. */
  seats?: number;
}

export interface SeatsResult {
  seats: number;
  previous: number;
  /** Prorated plan credits granted for seats added in the current slice. */
  granted: number;
  balance: Balance;
}

export interface GrantResult {
  granted: number;
  expired: number;
  planExpiresAt: number | null;
  skipped?: 'stale';
  balance: Balance;
}

export interface TrialGrantResult {
  granted: number;
  expiresAt: number | null;
  /** `already`: this workspace had a trial before (one per workspace, ever). */
  skipped?: 'already';
  balance: Balance;
}

export interface PurchaseResult {
  credits: number;
  balance: Balance;
}

export interface ExpireResult {
  expired: number;
  granted: number;
  balance: Balance;
}

export interface IdemRecord {
  key: string;
  op: string;
  fingerprint: string;
  result: unknown;
  createdAt: number;
}

export type LedgerErrorCode =
  | 'NO_PLAN'
  | 'INSUFFICIENT_CREDITS'
  | 'MEMBER_LIMIT_REACHED'
  | 'CONCURRENCY_LIMIT'
  | 'QUOTE_EXPIRED'
  | 'NOT_FOUND'
  | 'JOB_CLOSED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AGENT_ALLOWANCE_EXHAUSTED'
  | 'BAD_REQUEST';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Result shape for RPC boundaries, where thrown errors lose their fields. */
export type LedgerOutcome<T> = { ok: true; value: T } | { ok: false; error: { code: LedgerErrorCode; message: string; data: Record<string, unknown> } };

export type { ListingModel };
