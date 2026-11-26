import { TEAM_SEATS } from '@rolling/core/pricing/config';
import { ApiError, type ApiErrorCode } from '@/lib/api/errors';
import type { CreditsBreakdown, SessionPlan } from './store';

/**
 * Session pieces both modes share: the flow error, seat clamping, result
 * shapes, and the mock test seams (`window.__rollingMocks`, mock workspace
 * choice). No demo data lives here: the mock identity, balances and flows
 * are in `./mock.ts`, reached only through the mock-mode adapter
 * (`mockData().session`, lib/api/mode.ts).
 */

export interface SessionMockOverrides {
  plan?: SessionPlan | null;
  /** A signed-out visitor (public pages, One Tap). */
  signedOut?: boolean;
  workspace?: { matureAllowed?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

/** How the mock checkout and mock runs end: `ok` (default), `fail` (payment or run error). */
export type MockOutcome = 'ok' | 'fail';

declare global {
  interface Window {
    __rollingMocks?: {
      me?: SessionMockOverrides;
      /** Starting balance for `useCredits` (default 2,480: 1,800 plan + 680 purchased). */
      credits?: Partial<CreditsBreakdown>;
      checkout?: MockOutcome;
      run?: MockOutcome;
      /** Mock latency in ms for checkout and runs (default 600). */
      latencyMs?: number;
      /**
       * Checkout leaves the page like Stripe: the app reloads at
       * `?checkout=success&session_id=cs_mock_…` and the plan or top-up applies
       * on return (resume-after-checkout flows, D-007).
       */
      checkoutRedirect?: boolean;
      /** `off`: payments are not configured (the upgrade modal shows "Payments aren't available yet"). */
      payments?: 'on' | 'off';
    };
  }
}

export const MOCK_MEMBER_KEY = 'rolling.mock.isMember';
/** Error the session flows reject with; `code` follows docs/api.md error codes (also thrown, wrapped, by the real API path). */
export class FlowError extends ApiError {
  constructor(code: ApiErrorCode, message: string = code, status = 0, data: Record<string, unknown> = {}) {
    super(code, message, status, data as never);
  }
}

/** Older name, kept for callers that check `instanceof MockFlowError`. */
export const MockFlowError = FlowError;
export type MockFlowError = FlowError;

/** The test seam `window.__rollingMocks.me`, if set. */
export function mockOverrides(): SessionMockOverrides {
  return (typeof window !== 'undefined' && window.__rollingMocks?.me) || {};
}

export function mocks() {
  return (typeof window !== 'undefined' && window.__rollingMocks) || {};
}

export function clampSeats(n: number): number {
  return Math.min(TEAM_SEATS.max, Math.max(TEAM_SEATS.min, Math.round(Number.isFinite(n) ? n : 1)));
}

/** Mock billing period for prorations: the current calendar month. */
export function mockPeriod(now = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}

export interface SeatChange {
  seats: number;
  previous: number;
  /** Prorated plan credits granted for added seats (D-013). */
  granted: number;
}

export interface TopUpResult {
  amountUsd: number;
  /** Credits added, bonus included. */
  credits: number;
  balance: number;
}

export interface MockRun {
  id: string;
  cost: number;
}

// Workspace switch (account menu).

export const ACTIVE_WORKSPACE_KEY = 'rolling.mock.workspace';
const workspaceListeners = new Set<() => void>();

export function getMockWorkspace(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setMockWorkspace(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  } catch {
    /* Storage unavailable. */
  }
  for (const l of workspaceListeners) l();
}

export function subscribeMockWorkspace(cb: () => void): () => void {
  workspaceListeners.add(cb);
  return () => workspaceListeners.delete(cb);
}

