import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_MAX_AGE_MS, peekHandoff, saveHandoff, startedFromHome, takeHandoff } from './handoff';

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

const brief = {
  projectId: 'prj_a',
  text: 'A 15s ad for a sparkling water',
  refs: ['ast_1', 'upl_2'],
  refNames: ['Bottle.png', 'Logo.png'],
  skill: '/TV ad',
  llm: 'deepseek-v4.1-flash',
  settings: { videoModel: null, ratio: '9:16', seconds: 15 },
  mode: 'auto' as const,
  autoBudget: 500,
};

describe('Home → canvas agent hand-off (D-039)', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is taken once, by its own project only, with every prompt box choice', () => {
    saveHandoff(brief);
    expect(peekHandoff('prj_other')).toBeNull();
    expect(takeHandoff('prj_other')).toBeNull();
    expect(peekHandoff('prj_a')?.text).toBe(brief.text);
    const h = takeHandoff('prj_a');
    expect(h).toMatchObject({ ...brief });
    expect(takeHandoff('prj_a')).toBeNull();
    // The project stays marked as started from Home after the brief was sent.
    expect(startedFromHome('prj_a')).toBe(true);
    expect(startedFromHome('prj_other')).toBe(false);
  });

  it('a newer brief replaces the older one; a stale one is dropped', () => {
    vi.useFakeTimers();
    saveHandoff(brief);
    saveHandoff({ ...brief, projectId: 'prj_b', text: 'Second' });
    expect(peekHandoff('prj_a')).toBeNull();
    expect(peekHandoff('prj_b')?.text).toBe('Second');
    vi.advanceTimersByTime(HANDOFF_MAX_AGE_MS + 1);
    expect(takeHandoff('prj_b')).toBeNull();
  });

  it('works without storage', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => saveHandoff(brief)).not.toThrow();
    expect(takeHandoff('prj_a')).toBeNull();
    expect(startedFromHome('prj_a')).toBe(false);
  });
});
