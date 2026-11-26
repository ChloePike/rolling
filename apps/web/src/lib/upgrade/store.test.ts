import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, onPlanError, setFetchForTests } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { closeUpgrade, getUpgrade, installPlanErrorHandler, openUpgrade, reasonFromPlanError } from './store';

const err = (code: string, data: Record<string, unknown> = {}) => new ApiError(code as never, code, 402, data as never);

afterEach(() => {
  closeUpgrade({ silent: true });
  setFetchForTests(null);
  onPlanError(null);
});

describe('upgrade store', () => {
  it('opens, replaces (dismissing the previous request) and closes with resume or dismiss', () => {
    const a = { onResume: vi.fn(), onDismiss: vi.fn() };
    const b = { onResume: vi.fn(), onDismiss: vi.fn() };
    openUpgrade({ kind: 'agent' }, a);
    expect(getUpgrade()?.reason).toEqual({ kind: 'agent' });
    openUpgrade({ kind: 'resolution', value: '1080p' }, b);
    expect(a.onDismiss).toHaveBeenCalledOnce();
    closeUpgrade({ resumed: true });
    expect(b.onResume).toHaveBeenCalledOnce();
    expect(b.onDismiss).not.toHaveBeenCalled();
    expect(getUpgrade()).toBeNull();
  });

  it('closing another request id is a no-op; silent closes run no callbacks', () => {
    const o = { onResume: vi.fn(), onDismiss: vi.fn() };
    const id = openUpgrade({ kind: 'mature' }, o);
    closeUpgrade({ id: id + 1 });
    expect(getUpgrade()?.id).toBe(id);
    closeUpgrade({ id, silent: true });
    expect(getUpgrade()).toBeNull();
    expect(o.onDismiss).not.toHaveBeenCalled();
  });
});

describe('shared API error handler → reason', () => {
  const ev = (code: string, path: string, data: Record<string, unknown> = {}, body: unknown = {}) => reasonFromPlanError({ error: err(code, data), method: 'POST', path, body });
  it('maps codes and paths', () => {
    expect(ev('RESOLUTION_LOCKED', '/api/runs/quote', { resolution: '4K', kind: 'image' })).toEqual({ kind: 'resolution', value: '4K', media: 'image' });
    expect(ev('TEAM_REQUIRED', '/api/workspace/invites')).toEqual({ kind: 'team-invite' });
    expect(ev('PLAN_REQUIRED', '/api/x', { plan: 'pro' })).toEqual({ kind: 'plan', plan: 'pro' });
    expect(ev('NO_PLAN', '/api/agent/threads/t1/turns')).toEqual({ kind: 'agent' });
    expect(ev('NO_PLAN', '/api/me/prefs', {}, { matureContent: true })).toEqual({ kind: 'mature' });
    expect(ev('NO_PLAN', '/api/billing/auto-topup')).toEqual({ kind: 'auto-top-up' });
    expect(ev('NO_PLAN', '/api/billing/checkout')).toEqual({ kind: 'top-up' });
    expect(ev('NO_PLAN', '/api/runs')).toEqual({ kind: 'generate' });
  });

  it('commands with plan errors open the modal; GET requests and planGate:false do not', async () => {
    installPlanErrorHandler();
    setFetchForTests(async () => new Response(JSON.stringify({ error: { code: 'NO_PLAN', message: 'no plan', data: {} } }), { status: 402 }));
    await expect(apiRequest('/agent/allowance')).rejects.toBeInstanceOf(ApiError);
    expect(getUpgrade()).toBeNull();
    await expect(apiRequest('/runs', { method: 'POST', body: {}, planGate: false })).rejects.toBeInstanceOf(ApiError);
    expect(getUpgrade()).toBeNull();
    await expect(apiRequest('/agent/threads/t/turns', { method: 'POST', body: { text: 'hi' } })).rejects.toMatchObject({ code: 'NO_PLAN' });
    expect(getUpgrade()?.reason).toEqual({ kind: 'agent' });
  });
});
