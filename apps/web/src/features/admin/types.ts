/** Admin console API shapes (`/api/admin/*`, docs/api.md → Operations). */
export type StaffRole = 'admin' | 'reviewer';
export type Permission = 'view' | 'review' | 'credits' | 'plans' | 'ops' | 'staff' | 'child_safety';

export interface AdminMe {
  role: StaffRole;
  email: string | null;
  permissions: Permission[];
}

export interface DailyRow {
  day: string;
  signups: number;
  planStarts: number;
  started: number;
  succeeded: number;
  failed: number;
  agentTurns: number;
  creditsSpent: number;
  gatewayCostUsd: number;
  agentCostUsd: number;
}

export interface ModelRow {
  model: string;
  started: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  creditsSpent: number;
  gatewayCostUsd: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface Dashboard {
  days: string[];
  daily: DailyRow[];
  models: ModelRow[];
  totals: { signups: number; planStarts: number; trialsActive: number; activePlans: number; creditsSpent: number; gatewayCostUsd: number; agentCostUsd: number; revenueUsd: number; marginUsd: number; marginPct: number | null };
  latency: { available: boolean; reason: string | null; colos: { colo: string; requests: number; p50Ms: number | null; p90Ms: number | null }[] };
}

export interface SearchResult {
  users: { id: string; email: string; name: string; created_at: string }[];
  workspaces: { id: string; name: string; kind: string; safety_flag: number; created_at: number }[];
}

export interface LedgerLine {
  id: string;
  kind: string;
  bucket: string;
  amount: number;
  runId: string | null;
  jobId: string | null;
  note: string | null;
  createdAt: number;
}

export interface WorkspaceDetail {
  workspace: { id: string; name: string; kind: string; safety_flag: number; created_at: number };
  members: { user_id: string; role: string; email: string | null; name: string | null }[];
  subscriptions: { id: string; plan: string; status: string; current_period_end: number; seats: number }[];
  plan: string | null;
  balance: { plan: number; purchased: number; held: number };
  ledger: LedgerLine[];
  runs: { id: string; title: string | null; status: string; credits_spent: number; credits_refunded: number; created_at: number }[];
  safetyEvents: { id: string; stage: string; codes: string[]; hard: number; created_at: number }[];
  suspensions: { id: string; reason: string; created_at: number; lifted_at: number | null }[];
  cases: { id: string; kind: string; status: string; priority: number; created_at: number }[];
}

export interface UserDetail {
  user: { id: string; email?: string; name?: string; created_at?: string };
  memberships: { workspace_id: string; role: string; name: string; kind: string; plan: string | null }[];
  suspensions: { id: string; reason: string; created_at: number; lifted_at: number | null }[];
  notices: { id: string; kind: string; message: string; created_at: number }[];
  safetyEvents: { id: string; workspace_id: string; stage: string; codes: string; hard: number; created_at: number }[];
  cases: { id: string; kind: string; status: string; priority: number; created_at: number }[];
}

export type CaseKind = 'safety' | 'report' | 'appeal' | 'dmca' | 'counter_notice' | 'child_safety';

export interface CaseItem {
  id: string;
  kind: CaseKind;
  status: 'open' | 'actioned' | 'dismissed' | 'closed';
  priority: number;
  category: string | null;
  workspaceId: string | null;
  userId: string | null;
  targetKind: string | null;
  targetId: string | null;
  resolution: string | null;
  createdAt: number;
}

export interface CaseView {
  case: CaseItem & { details: string | null; reporterEmail: string | null; targetUrl: string | null; data: Record<string, unknown> };
  user: { id: string; email: string; name: string } | null;
  workspace: { id: string; name: string; safety_flag: number } | null;
  events: { id: string; stage: string; codes: string[]; excerpt: string | null; created_at: number }[];
  evidence: { id: string; kind: string; sha256: string | null; size: number | null; contentType: string | null; capturedAt: number }[];
  history: { id: string; action: string; reason: string | null; created_at: number }[];
  actions: string[];
}

export interface AuditRow {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  reason: string | null;
  created_at: number;
}

export interface OpsStatus {
  overall: 'operational' | 'degraded' | 'outage';
  components: { id: 'api' | 'gateway' | 'media' | 'auth'; status: 'operational' | 'degraded' | 'down' | 'unknown'; latencyMs: number | null; checkedAt: number | null; uptime24h: number | null }[];
  generation: { available: boolean; breaker: 'closed' | 'open' | 'half_open'; since: number | null };
  incident: { message: string; level: 'info' | 'degraded' | 'outage'; updatedAt: number } | null;
  updatedAt: number;
  breakerDetail: { state: string; failures: number; lastError: string | null };
  backups: { id: string; status: string; credit_accounts: number; project_rooms: number; bytes: number; started_at: number; finished_at: number | null }[];
}
