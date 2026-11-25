import type { PlanId } from '@rolling/core/pricing/config';

/** Shapes follow docs/api.md (`GET /api/me`, billing, workspace routes). */
export type CreationMode = 'simple' | 'advanced';
export type Role = 'owner' | 'editor' | 'viewer';
export type BillingPeriod = 'monthly' | 'yearly';

export interface Prefs {
  language: string;
  currency: string;
  creationMode: CreationMode;
  defaultRatio: string;
  defaultModel: string;
  confirmThreshold: number;
  /** D-005: show mature models and outputs. Visibility only, default off. */
  matureContent: boolean;
  notifications: {
    generationFinished: boolean;
    creditsLow: boolean;
    planRenewal: boolean;
    productUpdates: boolean;
  };
}

export interface Me {
  user: { id: string; name: string; handle: string; email: string; signIn: 'google' | 'apple' | 'email' };
  workspace: { id: string; name: string; matureAllowed: boolean };
  role: Role;
  prefs: Prefs;
  /** Null when the workspace has no active plan. */
  plan: { id: PlanId; period: BillingPeriod; status: 'active' | 'canceled' } | null;
  balance: { plan: number; purchased: number; held: number };
  autoTopUp: { enabled: boolean; below: number; amountUsd: number };
  paymentMethod: { brand: string; last4: string } | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Credits per month; null means no limit. Viewers cannot spend. */
  monthlyCreditLimit: number | null;
}

export interface Invoice {
  id: string;
  kind: 'plan' | 'topUp';
  planId?: PlanId;
  period?: BillingPeriod;
  /** Top-up amount for `kind: 'topUp'`. */
  amountUsd?: number;
}
