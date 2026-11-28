import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPendingToCheckout, hasPendingAction, markCheckoutResumed, resetPendingForTests, savePendingAction, takePendingAction } from './pending';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('pending actions (resume after checkout)', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    resetPendingForTests();
  });

  it('an unbound action is taken once, by kind and only when accepted', () => {
    savePendingAction('tools.run', { path: '/create/avatar', prompt: 'hi' });
    expect(takePendingAction('home.agent')).toBeNull();
    expect(takePendingAction<{ path: string }>('tools.run', (d) => d.path === '/create/remix')).toBeNull();
    expect(takePendingAction<{ path: string }>('tools.run', (d) => d.path === '/create/avatar')).toEqual({ path: '/create/avatar', prompt: 'hi' });
    expect(takePendingAction('tools.run')).toBeNull();
  });

  it('anySlot sees an action bound to a checkout that has not completed yet', () => {
    savePendingAction('home.agent', { text: 'a trailer' });
    bindPendingToCheckout('cs_9');
    expect(hasPendingAction('home.agent')).toBe(false);
    expect(hasPendingAction('home.agent', undefined, { anySlot: true })).toBe(true);
    expect(hasPendingAction('home.run', undefined, { anySlot: true })).toBe(false);
    markCheckoutResumed('cs_9');
    expect(takePendingAction('home.agent')).toEqual({ text: 'a trailer' });
    expect(hasPendingAction('home.agent', undefined, { anySlot: true })).toBe(false);
  });

  it('an action bound to a checkout replays only after that checkout completed', () => {
    savePendingAction('editor.ask', { projectId: 'prj_1', request: 'cut to 10s' });
    bindPendingToCheckout('cs_1');
    expect(takePendingAction('editor.ask')).toBeNull();
    markCheckoutResumed('cs_other');
    expect(takePendingAction('editor.ask')).toBeNull();
    markCheckoutResumed('cs_1');
    expect(takePendingAction('editor.ask')).toEqual({ projectId: 'prj_1', request: 'cut to 10s' });
    expect(takePendingAction('editor.ask')).toBeNull();
  });

  it('drops actions older than an hour', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * 3_600_000);
    savePendingAction('tools.run', { prompt: 'old' });
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(takePendingAction('tools.run')).toBeNull();
    vi.restoreAllMocks();
  });
});
