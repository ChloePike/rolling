/** Public status and trust & safety shapes (`/api/status`, `/api/trust/*`). */
export type ComponentId = 'api' | 'gateway' | 'media' | 'auth';
export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'unknown';

export interface Incident {
  message: string;
  level: 'info' | 'degraded' | 'outage';
  updatedAt: number;
}

export interface StatusView {
  overall: 'operational' | 'degraded' | 'outage';
  components: { id: ComponentId; status: ComponentStatus; latencyMs: number | null; checkedAt: number | null; uptime24h: number | null }[];
  generation: { available: boolean; breaker: 'closed' | 'open' | 'half_open'; since: number | null };
  incident: Incident | null;
  updatedAt: number;
}

export interface TrustMe {
  suspension: { id: string; scope: 'user' | 'workspace'; since: number; message: string } | null;
  notices: { id: string; kind: string; message: string; caseId: string | null; createdAt: number }[];
}

export const REPORT_CATEGORIES = ['child_safety', 'sexual_real_person', 'non_consensual', 'violence', 'extremism', 'self_harm', 'harassment', 'impersonation', 'illegal', 'spam', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
