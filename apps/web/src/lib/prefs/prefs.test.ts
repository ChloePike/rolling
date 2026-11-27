import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal window + localStorage + document for the node test environment. */
function stubBrowser() {
  const store = new Map<string, string>();
  const target = new EventTarget();
  const dataset: Record<string, string> = {};
  vi.stubGlobal('window', Object.assign(target, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  }));
  vi.stubGlobal('CustomEvent', class extends Event {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      super(type);
      this.detail = init?.detail;
    }
  });
  vi.stubGlobal('document', { documentElement: { dataset, style: {} } });
  return { store, dataset };
}

describe('lib/prefs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('defaults, then persists every preference in storage', async () => {
    const { store } = stubBrowser();
    const prefs = await import('./index');
    expect(prefs.getPrefs()).toMatchObject({ currency: 'USD', defaultAspectRatio: '9:16', notifyWhenDone: true, theme: 'system', confirmThreshold: 300 });
    prefs.setPrefs({ currency: 'JPY', defaultAspectRatio: '21:9', notifyWhenDone: false });
    prefs.setLanguage('ko');
    prefs.setCreationMode('advanced');
    expect(store.get('rolling.locale')).toBe('ko');
    expect(store.get('rolling.creationMode')).toBe('advanced');
    vi.resetModules();
    const again = await import('./index');
    expect(again.getPrefs()).toMatchObject({ currency: 'JPY', defaultAspectRatio: '21:9', notifyWhenDone: false, language: 'ko', creationMode: 'advanced' });
  });

  it('returns a stable snapshot until something changes', async () => {
    stubBrowser();
    const prefs = await import('./index');
    const a = prefs.getPrefs();
    expect(prefs.getPrefs()).toBe(a);
    prefs.setPref('theme', 'light');
    expect(prefs.getPrefs()).not.toBe(a);
  });

  it('ignores unknown stored values', async () => {
    const { store } = stubBrowser();
    store.set('rolling.prefs', JSON.stringify({ currency: 'XXX', theme: 'neon', confirmThreshold: -4 }));
    const prefs = await import('./index');
    expect(prefs.getPrefs()).toMatchObject({ currency: 'USD', theme: 'system', confirmThreshold: 300 });
  });

  it('applies the theme as data-theme and removes it for System (D-010)', async () => {
    const { dataset } = stubBrowser();
    const prefs = await import('./index');
    prefs.setPref('theme', 'light');
    expect(dataset.theme).toBe('light');
    prefs.setPref('theme', 'dark');
    expect(dataset.theme).toBe('dark');
    prefs.setPref('theme', 'system');
    expect(dataset.theme).toBeUndefined();
  });

  it('formats prices in USD only, whatever currency is passed (D-019)', async () => {
    stubBrowser();
    const { formatPrice } = await import('./currency');
    const intl = { formatNumber: (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', o).format(n) } as never;
    expect(formatPrice(intl, 25)).toBe('$25');
    expect(formatPrice(intl, 39.17)).toBe('$39.17');
    expect(formatPrice(intl, 25, 'JPY')).toBe('$25');
    expect(formatPrice(intl, 10, 'EUR')).toBe('$10');
    const de = { formatNumber: (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat('de', o).format(n) } as never;
    expect(formatPrice(de, 1234.5)).toBe(new Intl.NumberFormat('de', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(1234.5));
  });
});

describe('lib/prefs server sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('maps client prefs to the PATCH body and back', async () => {
    stubBrowser();
    const prefs = await import('./index');
    expect(prefs.toServerPatch({ defaultAspectRatio: '16:9', notifyWhenDone: false, notifyProductUpdates: true, theme: 'light' })).toEqual({
      defaultRatio: '16:9',
      theme: 'light',
      notifications: { done: false, product: true },
    });
    // D-023: a pre-D-023 zh-HK choice saves as Traditional Chinese; zh-CN is offered.
    expect(prefs.toServerPatch({ language: 'zh-HK' })).toEqual({ language: 'zh-TW' });
    expect(prefs.toServerPatch({ language: 'zh-CN' })).toEqual({ language: 'zh-CN' });
    expect(prefs.toServerPatch({ language: 'zh-Hans-SG' })).toEqual({ language: 'zh-CN' });
    const p = prefs.fromServerPrefs({ language: 'ja', currency: 'JPY', creationMode: 'advanced', defaultRatio: '1:1', defaultModel: 'auto', confirmThreshold: 0, notifications: { done: true, low: false, renewal: true, product: false }, theme: 'dark', matureContent: true });
    expect(p).toMatchObject({ language: 'ja', currency: 'JPY', defaultAspectRatio: '1:1', notifyCreditsLow: false, confirmThreshold: 0, theme: 'dark', matureContent: true });
  });

  it('D-020: Enhance prompt defaults on, persists, and maps to and from the server', async () => {
    stubBrowser();
    const prefs = await import('./index');
    expect(prefs.getPrefs().enhancePrompt).toBe(true);
    prefs.setPrefs({ enhancePrompt: false });
    vi.resetModules();
    expect((await import('./index')).getPrefs().enhancePrompt).toBe(false);
    expect(prefs.toServerPatch({ enhancePrompt: false })).toEqual({ enhancePrompt: false });
    const base = { language: 'en', currency: 'USD', creationMode: 'simple' as const, defaultRatio: '9:16', defaultModel: 'auto', confirmThreshold: 300, notifications: { done: true, low: true, renewal: true, product: false }, theme: 'dark' as const, matureContent: false };
    expect(prefs.fromServerPrefs(base).enhancePrompt).toBe(true);
    expect(prefs.fromServerPrefs({ ...base, enhancePrompt: false }).enhancePrompt).toBe(false);
  });

  it('writes optimistically, sends to the remote, and rolls back on a refusal', async () => {
    stubBrowser();
    const prefs = await import('./index');
    const errors: unknown[] = [];
    window.addEventListener(prefs.PREFS_ERROR_EVENT, (e) => errors.push((e as CustomEvent).detail));
    const sent: unknown[] = [];
    prefs.registerPrefsRemote(async (patch) => {
      sent.push(patch);
      if ('matureContent' in patch) throw Object.assign(new Error('NO_PLAN'), { code: 'NO_PLAN' });
    });
    await prefs.savePrefs({ theme: 'light' });
    expect(prefs.getPrefs().theme).toBe('light');
    const p = prefs.savePrefs({ matureContent: true });
    expect(prefs.getPrefs().matureContent).toBe(true);
    await expect(p).rejects.toThrow('NO_PLAN');
    expect(prefs.getPrefs().matureContent).toBe(false);
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([{ theme: 'light' }, { matureContent: true }]);
    prefs.registerPrefsRemote(null);
  });

  it('server prefs apply live, except keys with a save in flight', async () => {
    stubBrowser();
    const prefs = await import('./index');
    let release!: () => void;
    prefs.registerPrefsRemote(() => new Promise<void>((r) => (release = r)));
    const pending = prefs.savePrefs({ currency: 'GBP' });
    prefs.applyServerPrefs({ language: 'en', currency: 'USD', creationMode: 'simple', defaultRatio: '9:16', defaultModel: 'auto', confirmThreshold: 300, notifications: { done: true, low: true, renewal: true, product: false }, theme: 'dark', matureContent: false });
    expect(prefs.getPrefs()).toMatchObject({ currency: 'GBP', theme: 'dark' });
    release();
    await pending;
    prefs.registerPrefsRemote(null);
  });
});
