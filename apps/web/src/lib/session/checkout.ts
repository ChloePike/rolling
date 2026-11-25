import { useEffect, useRef } from 'react';
import type { PlanId } from '@rolling/core/pricing/config';
import { api } from '@/lib/api/client';
import { ApiError, isApiError } from '@/lib/api/errors';
import type { CheckoutOutcome, CheckoutStarted, Interval, SeatsChanged } from '@/lib/api/types';
import { FlowError } from './mock';
import { refetchMe } from './real';
import { bindPendingToCheckout, markCheckoutResumed } from './pending';

/**
 * Stripe Checkout (docs/api.md → Account and billing): start a checkout, go
 * to Stripe, come back to `<returnTo>?checkout=success&session_id=…`, poll
 * `GET /api/billing/checkout/:sessionId` until the webhook applied it, then
 * resume the pending action (`resume.runQuoteId`).
 */

export interface CheckoutOptions {
  /** The run quote to continue after paying (run flow, paywalls). */
  resume?: { runQuoteId: string };
  /** App path Stripe returns to (default: the current page). */
  returnTo?: string;
}

/** Search params the return adds; stripped once handled. */
export const RETURN_PARAMS = ['checkout', 'session_id', 'portal'] as const;

/** The current page without the return params (the default `returnTo`). */
export function currentReturnPath(loc: Pick<Location, 'pathname' | 'search'> = window.location): string {
  const q = new URLSearchParams(loc.search);
  for (const k of RETURN_PARAMS) q.delete(k);
  const s = q.toString();
  return `${loc.pathname}${s ? `?${s}` : ''}`;
}

/** Leaves the app for Stripe. Test seam: `window.__rollingRedirect(url)` replaces the navigation. */
export function redirectTo(url: string) {
  const seam = (window as unknown as { __rollingRedirect?: (u: string) => void }).__rollingRedirect;
  if (seam) seam(url);
  else window.location.assign(url);
}

/** Wraps an API failure into the flow error the paywalls and run flow branch on. */
export function flowError(e: unknown): never {
  if (e instanceof FlowError) throw e;
  if (e instanceof ApiError) throw new FlowError(e.code, e.message, e.status, e.data as Record<string, unknown>);
  throw e;
}

/** Never settles: the page is navigating away. */
const leaving = <T>() => new Promise<T>(() => {});

export const toInterval = (p: 'monthly' | 'yearly'): Interval => (p === 'yearly' ? 'year' : 'month');

/**
 * `POST /api/billing/checkout {kind:'plan'}`. Redirects to Stripe (the promise
 * never settles); a personal plan switching to Team in place (`switched`)
 * resolves after the session refetches.
 */
export async function realCheckoutPlan(planId: PlanId, period: 'monthly' | 'yearly', seats: number, opts: CheckoutOptions = {}): Promise<CheckoutStarted> {
  let r: CheckoutStarted;
  try {
    r = await api.post<CheckoutStarted>('/billing/checkout', {
      kind: 'plan',
      planId,
      interval: toInterval(period),
      ...(planId === 'team' ? { seats } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      returnTo: opts.returnTo ?? currentReturnPath(),
    });
  } catch (e) {
    flowError(e);
  }
  if (r.switched) {
    await refetchMe();
    return r;
  }
  if (r.url) {
    // The action the paywall interrupted resumes when this checkout completes.
    bindPendingToCheckout(r.sessionId);
    redirectTo(r.url);
    return leaving();
  }
  throw new FlowError('INTERNAL', 'Checkout did not return a URL');
}

/** `POST /api/billing/checkout {kind:'topUp'}` (members only, any amount $10–$10,000). Redirects to Stripe. */
export async function realCheckoutTopUp(amountUsd: number, opts: CheckoutOptions = {}): Promise<never> {
  let r: CheckoutStarted;
  try {
    r = await api.post<CheckoutStarted>('/billing/checkout', {
      kind: 'topUp',
      amountCents: Math.round(amountUsd * 100),
      ...(opts.resume ? { resume: opts.resume } : {}),
      returnTo: opts.returnTo ?? currentReturnPath(),
    });
  } catch (e) {
    flowError(e);
  }
  if (!r.url) throw new FlowError('INTERNAL', 'Checkout did not return a URL');
  bindPendingToCheckout(r.sessionId);
  redirectTo(r.url);
  return leaving();
}

/** `PATCH /api/billing/seats` (Team owners, D-013). */
export async function realChangeSeats(seats: number, idempotencyKey?: string): Promise<SeatsChanged> {
  try {
    const r = await api.patch<SeatsChanged>('/billing/seats', { seats }, idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : undefined);
    await refetchMe();
    return r;
  } catch (e) {
    flowError(e);
  }
}

/** `POST /api/billing/portal` → Stripe customer portal (card, plan change, cancel, invoices). */
export async function openBillingPortal(returnTo = currentReturnPath()): Promise<never> {
  let r: { url: string };
  try {
    r = await api.post<{ url: string }>('/billing/portal', { returnTo });
  } catch (e) {
    flowError(e);
  }
  redirectTo(r.url);
  return leaving();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the checkout outcome until the webhook completed (or expired) it, up to `timeoutMs`. */
export async function pollCheckout(sessionId: string, { timeoutMs = 30_000, intervalMs = 1000 } = {}): Promise<CheckoutOutcome> {
  const start = Date.now();
  for (;;) {
    const r = await api.get<CheckoutOutcome>(`/billing/checkout/${encodeURIComponent(sessionId)}`);
    if (r.status !== 'open' || Date.now() - start >= timeoutMs) return r;
    await sleep(intervalMs);
  }
}

// Resume after checkout: the run flow (or whatever started the checkout) picks it up.

export interface CheckoutResume {
  outcome: CheckoutOutcome;
  /** The run quote to continue (`resume.runQuoteId`), re-quoted on `QUOTE_EXPIRED`. */
  runQuoteId: string | null;
}

type ResumeListener = (r: CheckoutResume) => void;
const resumeListeners = new Set<ResumeListener>();
let buffered: { r: CheckoutResume; at: number } | null = null;
const BUFFER_MS = 2 * 60_000;

/**
 * Subscribes to completed checkouts. A completion that arrived before anyone
 * listened (the page was still loading) is delivered to the first listener.
 * Returns the unsubscribe function.
 */
export function onCheckoutResume(cb: ResumeListener): () => void {
  resumeListeners.add(cb);
  if (buffered && Date.now() - buffered.at < BUFFER_MS) {
    const r = buffered.r;
    buffered = null;
    queueMicrotask(() => cb(r));
  }
  return () => resumeListeners.delete(cb);
}

/** React form of `onCheckoutResume`. */
export function useCheckoutResume(cb: ResumeListener): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onCheckoutResume((r) => ref.current(r)), []);
}

export function emitCheckoutResume(r: CheckoutResume) {
  // Actions bound to this checkout (`savePendingAction` before the redirect) may replay now.
  markCheckoutResumed(r.outcome.sessionId);
  if (!resumeListeners.size) {
    buffered = { r, at: Date.now() };
    return;
  }
  for (const l of resumeListeners) l(r);
}

/** Codes a failed checkout start maps to in the UI. */
export function isCheckoutBlocked(e: unknown): boolean {
  return isApiError(e, 'NO_PLAN') || isApiError(e, 'CONFLICT') || isApiError(e, 'SEATS_REQUIRED');
}
