import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiRequest } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi, mockData } from '@/lib/api/mode';
import type { AdminMe, AuditRow, CaseItem, CaseView, Dashboard, OpsStatus, SearchResult, UserDetail, WorkspaceDetail } from './types';

/**
 * Admin console client (`/api/admin/*`, D-025). The server checks staff and
 * permissions on every route; the SPA only hides what the role cannot use.
 * Admin calls never carry the workspace header (they name their target).
 */
const NW = { noWorkspace: true } as const;
const m = () => mockData().admin;

/** Null when the caller is not staff (the server answers 404). */
export async function fetchAdminMe(): Promise<AdminMe | null> {
  if (isMockApi()) return m().mockMe();
  try {
    return await api.get<AdminMe>('/admin/me', NW);
  } catch (e) {
    if (isApiError(e, 'NOT_FOUND') || isApiError(e, 'FORBIDDEN')) return null;
    throw e;
  }
}

export const useAdminMe = () => useQuery({ queryKey: ['admin', 'me'], queryFn: fetchAdminMe, staleTime: 5 * 60_000, retry: false });

export const useDashboard = (days: number) =>
  useQuery({ queryKey: ['admin', 'metrics', days], queryFn: () => (isMockApi() ? Promise.resolve(m().mockDashboard(days)) : api.get<Dashboard>('/admin/metrics', { ...NW, query: { days } })) });

export const useSearch = (q: string) =>
  useQuery({ queryKey: ['admin', 'search', q], enabled: q.trim().length > 0, queryFn: () => (isMockApi() ? Promise.resolve(m().mockSearch(q)) : api.get<SearchResult>('/admin/search', { ...NW, query: { q } })) });

export const useWorkspace = (id: string) =>
  useQuery({ queryKey: ['admin', 'workspace', id], queryFn: () => (isMockApi() ? Promise.resolve(m().mockWorkspace(id)) : api.get<WorkspaceDetail>(`/admin/workspaces/${encodeURIComponent(id)}`, NW)) });

export const useUser = (id: string) =>
  useQuery({ queryKey: ['admin', 'user', id], queryFn: () => (isMockApi() ? Promise.resolve(m().mockUser(id)) : api.get<UserDetail>(`/admin/users/${encodeURIComponent(id)}`, NW)) });

export const useCases = (role: 'admin' | 'reviewer', kind?: string) =>
  useQuery({
    queryKey: ['admin', 'cases', kind ?? 'all'],
    queryFn: () => (isMockApi() ? Promise.resolve(m().mockCases(role)) : api.get<{ items: CaseItem[]; flaggedWorkspaces: number }>('/admin/cases', { ...NW, query: { kind } })),
  });

export const useCase = (id: string) =>
  useQuery({ queryKey: ['admin', 'case', id], queryFn: () => (isMockApi() ? Promise.resolve(m().mockCase(id)) : api.get<CaseView>(`/admin/cases/${encodeURIComponent(id)}`, NW)) });

export const useOpsStatus = () =>
  useQuery({ queryKey: ['admin', 'status'], queryFn: () => (isMockApi() ? Promise.resolve(m().mockOpsStatus()) : api.get<OpsStatus>('/admin/status', NW)) });

export const useAudit = () => useQuery({ queryKey: ['admin', 'audit'], queryFn: () => (isMockApi() ? Promise.resolve(m().mockAudit()) : api.get<{ items: AuditRow[] }>('/admin/audit', NW)) });

function useAdminMutation<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }) });
}

export const useAdjustCredits = (workspaceId: string) =>
  useAdminMutation((i: { amount: number; reason: string }) =>
    isMockApi()
      ? Promise.resolve(m().mockAdjust(i.amount))
      : api.post(`/admin/workspaces/${encodeURIComponent(workspaceId)}/credits`, { ...i, idemKey: `web-${crypto.randomUUID()}` }, NW),
  );

export const useGrantPlan = (workspaceId: string) =>
  useAdminMutation((i: { planId: string; months: number; seats: number; extraCredits: number; reason: string }) =>
    isMockApi() ? Promise.resolve({ ok: true }) : api.post(`/admin/workspaces/${encodeURIComponent(workspaceId)}/grant`, i, NW),
  );

export const useRefundRun = () =>
  useAdminMutation((i: { runId: string; reason: string }) => (isMockApi() ? Promise.resolve(m().mockRefund(i.runId)) : api.post(`/admin/runs/${encodeURIComponent(i.runId)}/refund`, { reason: i.reason }, NW)));

export const useSuspension = () =>
  useAdminMutation((i: { subjectKind: 'user' | 'workspace'; subjectId: string; action: 'suspend' | 'unsuspend'; reason: string }) =>
    isMockApi() ? Promise.resolve(m().mockSuspend(i.action)) : api.post('/admin/suspensions', i, NW),
  );

export const useCaseAction = (caseId: string) =>
  useAdminMutation((i: { action: string; reason: string; message?: string; scope?: 'user' | 'workspace'; reportId?: string }) =>
    isMockApi() ? Promise.resolve(m().mockAct(caseId, i.action)) : api.post(`/admin/cases/${encodeURIComponent(caseId)}/actions`, i, NW),
  );

export const useIncident = () =>
  useAdminMutation((i: { message: string; level: 'info' | 'degraded' | 'outage' }) =>
    isMockApi() ? Promise.resolve(m().mockIncident(i.message, i.level)) : apiRequest('/admin/incident', { ...NW, method: 'PUT', body: i }),
  );

export const useBreakerReset = () => useAdminMutation((i: { reason: string }) => (isMockApi() ? Promise.resolve({ ok: true }) : api.post('/admin/breaker/reset', i, NW)));
