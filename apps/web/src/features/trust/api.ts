import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isMockApi, mockData } from '@/lib/api/mode';
import type { ReportCategory, StatusView, TrustMe } from './types';

/** `GET /api/status` (public). Polled every minute for the app banner. */
export async function fetchStatus(): Promise<StatusView> {
  if (isMockApi()) return mockData().trust.mockStatus();
  return api.get<StatusView>('/status', { noWorkspace: true });
}

export function useStatus(opts: { poll?: boolean } = {}) {
  return useQuery({ queryKey: ['status'], queryFn: fetchStatus, staleTime: 30_000, refetchInterval: opts.poll ? 60_000 : false, retry: 1 });
}

/** `GET /api/trust/me`: the caller's suspension and unread notices. */
export async function fetchTrustMe(): Promise<TrustMe> {
  if (isMockApi()) return mockData().trust.mockTrustMe();
  return api.get<TrustMe>('/trust/me');
}

export function useTrustMe(enabled: boolean) {
  return useQuery({ queryKey: ['trust', 'me'], queryFn: fetchTrustMe, enabled, staleTime: 60_000, retry: false });
}

export interface ReportInput {
  targetKind: 'share' | 'profile' | 'url';
  targetId?: string;
  url?: string;
  category: ReportCategory;
  details: string;
  email?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (isMockApi()) return { caseId: mockData().trust.mockCaseId() } as T;
  return api.post<T>(path, body, { noWorkspace: path === '/trust/reports' || path === '/trust/dmca' });
}

export const submitReport = (input: ReportInput) => post<{ caseId: string }>('/trust/reports', input);
export const submitAppeal = (input: { subject: 'suspension' | 'block'; suspensionId?: string; runId?: string; message: string }) => post<{ caseId: string }>('/trust/appeals', input);
export const submitDmca = (input: Record<string, unknown>) => post<{ caseId: string }>('/trust/dmca', input);
export const submitCounterNotice = (input: Record<string, unknown>) => post<{ caseId: string }>('/trust/counter-notices', input);

export function useMarkNoticeRead() {
  return useMutation({ mutationFn: (id: string) => (isMockApi() ? Promise.resolve({ ok: true }) : api.post(`/trust/notices/${encodeURIComponent(id)}/read`)) });
}

/** Server copy of a safety block (D-005): the run can be appealed from its error line. */
export function isAppealableBlock(message: string | null | undefined): boolean {
  return !!message && message.startsWith('This can’t be generated under our content rules');
}
