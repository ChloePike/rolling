import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateSummary } from '@/features/templates/types';
import { firstRunState, rememberFirstRun, templatesFor } from './firstRun';

const t = (id: string, category: TemplateSummary['category'], extra: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id,
  name: id,
  durationSec: 10,
  uses: 0,
  roles: 0,
  hasLines: false,
  coverAspect: '9/16',
  category,
  ...extra,
});

describe('first-run', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });

  it('suggests templates that fit what the user makes, featured first', () => {
    const all = [t('a', 'product'), t('b', 'product', { featured: true }), t('c', 'drama'), t('d', 'talking'), t('e', 'product', { uses: 9 })];
    expect(templatesFor('ads', all).map((x) => x.id)).toEqual(['b', 'e', 'a']);
    expect(templatesFor('drama', all).map((x) => x.id)).toEqual(['c']);
    expect(templatesFor('social', all)).toEqual([]);
  });

  it('is remembered per user once done or skipped', () => {
    expect(firstRunState('usr_1')).toBeNull();
    rememberFirstRun('usr_1', 'skipped');
    expect(firstRunState('usr_1')).toBe('skipped');
    expect(firstRunState('usr_2')).toBeNull();
  });
});
