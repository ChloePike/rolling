/**
 * Response shapes of the routes the account side uses, as documented in
 * docs/api.md (Auth, Account, Account and billing, Workspaces and team,
 * Agent allowance, Sharing). Times are epoch ms, money in USD cents, credits
 * integers.
 */
import type { GraphEdge, GraphGroup } from '@rolling/core/graph';
import type { PlanId } from '@rolling/core/pricing/config';

export type Role = 'owner' | 'editor' | 'viewer';
export type Interval = 'month' | 'year';

export interface ServerNotificationPrefs {
  done: boolean;
  low: boolean;
  renewal: boolean;
  product: boolean;
}

export interface ServerPrefs {
  language: string;
  currency: string;
  creationMode: 'simple' | 'advanced';
  defaultRatio: string;
  defaultModel: string;
  confirmThreshold: number;
  notifications: ServerNotificationPrefs;
  theme: 'system' | 'light' | 'dark';
  matureContent: boolean;
}

export type ServerPrefsPatch = Partial<Omit<ServerPrefs, 'notifications'>> & { notifications?: Partial<ServerNotificationPrefs> };

export interface PlanView {
  id: PlanId;
  label: string;
  interval: Interval;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  perks: {
    monthlyCredits: number;
    topUpBonus: number;
    concurrentJobs: number;
    maxVideoResolution: string;
    maxImageResolution: string;
    voiceCloning: boolean;
    seats: number;
  };
}

export interface BalanceView {
  plan: number;
  purchased: number;
  held: number;
  planExpiresAt: number | null;
}

export interface WorkspaceRef {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: Role;
  plan: PlanId | null;
}

export interface MeResponse {
  user: { id: string; email: string | null; name: string; image: string | null; emailVerified: boolean };
  workspace: { id: string; name: string; kind: 'personal' | 'team'; matureAllowed: boolean };
  role: Role;
  monthlyCreditLimit: number | null;
  workspaces: WorkspaceRef[];
  prefs: ServerPrefs;
  plan: PlanView | null;
  isMember: boolean;
  matureAllowed: boolean;
  balance: BalanceView;
}

export interface AuthProviders {
  emailCode: boolean;
  google: boolean;
  apple: boolean;
}

export interface AutoTopUpView {
  enabled: boolean;
  thresholdCredits: number;
  amountCents: number;
}

export interface BillingSummary {
  plan: PlanId | null;
  interval: Interval | null;
  status: string | null;
  renewsAt: number | null;
  cancelAtPeriodEnd: boolean;
  periodEnd: number | null;
  periodStart: number | null;
  balance: BalanceView;
  autoTopUp: AutoTopUpView | null;
  seats: { purchased: number; used: number } | null;
}

export interface CheckoutStarted {
  url: string | null;
  sessionId: string | null;
  credits?: number;
  seats?: number;
  amountCents?: number;
  /** Personal → Team switched in place (no redirect, D-013). */
  switched?: boolean;
  planId?: PlanId;
  interval?: Interval;
}

export interface CheckoutOutcome {
  sessionId: string;
  kind: 'plan' | 'topUp';
  status: 'open' | 'complete' | 'expired';
  planId: PlanId | null;
  interval: Interval | null;
  amountCents: number | null;
  credits: number | null;
  completedAt: number | null;
  seats: number | null;
  resume: { runQuoteId: string } | null;
}

export interface SeatsPreview {
  seats: number;
  current: number;
  used: number;
  interval: Interval;
  prorationCents: number;
  renewalCents: number;
  periodEnd: number;
  addedMonthlyCredits: number;
}

export interface SeatsChanged {
  seats: { purchased: number; used: number };
  granted: number;
  changed: boolean;
  balance?: BalanceView;
}

export interface LedgerLine {
  id: string;
  kind: 'grant' | 'purchase' | 'hold' | 'settle' | 'release' | 'refund' | 'expire';
  bucket: 'plan' | 'purchased';
  amount: number;
  userId: string | null;
  runId: string | null;
  jobId: string | null;
  stripeRef: string | null;
  note: string | null;
  createdAt: number;
}

export interface LedgerPage {
  lines: LedgerLine[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export interface InvoiceView {
  id: string;
  number: string | null;
  createdAt: number;
  amountCents: number;
  currency: string;
  status: string;
  url: string | null;
  pdfUrl: string | null;
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  monthlyCreditLimit: number | null;
  isYou: boolean;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface MembersResponse {
  members: MemberView[];
  invites: InviteView[];
  seats: { used: number; limit: number; team: boolean };
}

export interface InviteLookup {
  workspace: { id: string; name: string };
  inviterName: string;
  email: string;
  role: Role;
  expiresAt: number;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export interface InviteAccepted {
  workspace: { id: string; name: string; kind: 'personal' | 'team' };
  role: Role;
}

export type AllowanceModelView =
  | { id: string; name: string; unlimited?: false; estTurnUsd: number; turnsLeft: number }
  | { id: string; name: string; unlimited: true; estTurnUsd?: undefined; turnsLeft?: undefined };

export interface AllowanceView {
  plan: PlanId | null;
  allowanceUsd: number;
  usedUsd: number;
  resetsAt: number;
  models: AllowanceModelView[];
}

export interface ShareMedia {
  kind: string;
  url: string | null;
  thumbUrl: string | null;
  downloadUrl: string | null;
}

export interface ShareNode {
  id: string;
  kind: string;
  title: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  groupId: string | null;
  media: ShareMedia | null;
}

export interface ShareSnapshot {
  shareId: string;
  title: string;
  revision: number;
  createdAt: number;
  allowDownload: boolean;
  nodes: ShareNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
}
