import { AUTO_TOP_UP, DEFAULT_CONFIRM_THRESHOLD_CREDITS } from '@rolling/core/pricing/config';
import type { Invoice, Me, Member } from './types';

/** Data from Settings.dc.html. */
export const meMock: Me = {
  user: { id: 'usr_alex', name: 'Alex Chen', handle: 'alexmakes', email: 'alex@ridgeline.co', signIn: 'google' },
  workspace: { id: 'ws_ridgeline', name: 'Ridgeline brand team', matureAllowed: true },
  role: 'owner',
  prefs: {
    language: 'en',
    currency: 'USD',
    creationMode: 'simple',
    defaultRatio: '9:16',
    defaultModel: 'auto',
    confirmThreshold: DEFAULT_CONFIRM_THRESHOLD_CREDITS,
    matureContent: false,
    notifications: { generationFinished: true, creditsLow: true, planRenewal: true, productUpdates: false },
  },
  plan: { id: 'pro', period: 'monthly', status: 'active' },
  // 2,480 total, as in the header; plan credits are capped by the plan's monthly grant (D-006).
  balance: { plan: 620, purchased: 1860, held: 0 },
  autoTopUp: { enabled: true, below: AUTO_TOP_UP.belowCredits, amountUsd: AUTO_TOP_UP.amountUsd },
  paymentMethod: { brand: 'Visa', last4: '4242' },
};

export const membersMock: Member[] = [
  { id: 'mem_alex', name: 'Alex Chen', email: 'alex@ridgeline.co', role: 'owner', monthlyCreditLimit: null },
  { id: 'mem_jordan', name: 'Jordan Lee', email: 'jordan@ridgeline.co', role: 'editor', monthlyCreditLimit: 1000 },
  { id: 'mem_sam', name: 'Sam Park', email: 'sam@ridgeline.co', role: 'editor', monthlyCreditLimit: 500 },
  { id: 'mem_priya', name: 'Priya Nair', email: 'priya@ridgeline.co', role: 'viewer', monthlyCreditLimit: null },
];

export const invoicesMock: Invoice[] = [
  { id: 'in_3', kind: 'plan', planId: 'pro', period: 'monthly' },
  { id: 'in_2', kind: 'topUp', amountUsd: 25 },
  { id: 'in_1', kind: 'plan', planId: 'pro', period: 'monthly' },
];
