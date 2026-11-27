import type { StatusView, TrustMe } from './types';

/** Mock status and trust data (mock mode only, through `mockData().trust`). */
export function mockStatus(): StatusView {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { status?: Partial<StatusView> } }).__rollingMocks?.status : undefined;
  const now = Date.now();
  return {
    overall: 'operational',
    components: (['api', 'gateway', 'media', 'auth'] as const).map((id) => ({ id, status: 'operational', latencyMs: id === 'gateway' ? 420 : 38, checkedAt: now - 120_000, uptime24h: 1 })),
    generation: { available: true, breaker: 'closed', since: null },
    incident: null,
    updatedAt: now,
    ...w,
  };
}

export function mockTrustMe(): TrustMe {
  const w = typeof window !== 'undefined' ? (window as unknown as { __rollingMocks?: { trust?: Partial<TrustMe> } }).__rollingMocks?.trust : undefined;
  return { suspension: null, notices: [], ...w };
}

let seq = 0;
export function mockCaseId(): string {
  seq++;
  return `case_mock${String(seq).padStart(4, '0')}`;
}
