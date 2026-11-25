import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getWorkspaceId, setFetchForTests, setWorkspaceId } from './client';
import { ApiError, errorFromBody, isApiError } from './errors';

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  return store;
}

describe('lib/api', () => {
  beforeEach(() => stubStorage());
  afterEach(() => {
    setFetchForTests(null);
    setWorkspaceId(null);
    vi.unstubAllGlobals();
  });

  it('maps the error envelope to typed errors', () => {
    const e = errorFromBody(402, { error: { code: 'SEATS_REQUIRED', message: 'Add a seat', data: { seats: 3, used: 3, needed: 4 } } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(402);
    expect(e.is('SEATS_REQUIRED') && e.data.needed).toBe(4);
    expect(errorFromBody(429, { error: { code: 'AGENT_ALLOWANCE_EXHAUSTED', message: '', data: { resetsAt: 1 } } }).code).toBe('AGENT_ALLOWANCE_EXHAUSTED');
    expect(errorFromBody(500, '<html>').code).toBe('INTERNAL');
    expect(errorFromBody(401, null).code).toBe('UNAUTHENTICATED');
    expect(errorFromBody(400, { error: { code: 'SOMETHING_NEW', message: 'x', data: {} } }).code).toBe('UNKNOWN');
  });

  it('sends cookies, JSON and the active workspace header; throws ApiError on failure', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    setFetchForTests(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).includes('/billing/checkout')) return new Response(JSON.stringify({ error: { code: 'NO_PLAN', message: 'no', data: {} } }), { status: 402 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    setWorkspaceId('ws_team');
    expect(getWorkspaceId()).toBe('ws_team');
    await api.patch('/me/prefs', { theme: 'dark' });
    expect(calls[0]!.url).toBe('/api/me/prefs');
    expect(calls[0]!.init).toMatchObject({ method: 'PATCH', credentials: 'include', body: '{"theme":"dark"}' });
    expect((calls[0]!.init.headers as Record<string, string>)['x-workspace-id']).toBe('ws_team');
    await api.get('/auth/providers', { noWorkspace: true, query: { a: 1, b: undefined } });
    expect(calls[1]!.url).toBe('/api/auth/providers?a=1');
    expect((calls[1]!.init.headers as Record<string, string>)['x-workspace-id']).toBeUndefined();
    const err = await api.post('/billing/checkout', { kind: 'topUp', amountCents: 1000 }).catch((e: unknown) => e);
    expect(isApiError(err, 'NO_PLAN')).toBe(true);
  });

  it('network failures become NETWORK errors', async () => {
    setFetchForTests(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });
});
