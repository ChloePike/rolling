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

  it('formats prices in the chosen currency', async () => {
    stubBrowser();
    const { formatPrice } = await import('./currency');
    const intl = { formatNumber: (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', o).format(n) } as never;
    expect(formatPrice(intl, 25)).toBe('$25');
    expect(formatPrice(intl, 39.17)).toBe('$39.17');
    expect(formatPrice(intl, 25, 'JPY')).toBe('¥3,750');
    expect(formatPrice(intl, 10, 'EUR')).toBe('€9.20');
  });
});
