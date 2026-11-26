import { describe, expect, it } from 'vitest';
import {
  applyPrefsPatch,
  currencyForLocale,
  DEFAULT_PREFS,
  initialPrefs,
  languageFromAcceptLanguage,
  parseAcceptLanguage,
  PrefsPatch,
  prefsFromRow,
} from './prefs';
import { roleAtLeast } from './roles';

describe('Accept-Language', () => {
  it('orders tags by quality', () => {
    expect(parseAcceptLanguage('fr;q=0.5, de-DE, *;q=0.1, en;q=0')).toEqual(['de-DE', 'fr']);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it.each([
    ['ja-JP,ja;q=0.9', 'ja'],
    ['zh-TW', 'zh-TW'],
    ['zh-Hant-HK', 'zh-HK'],
    ['zh-Hant', 'zh-TW'],
    ['zh-CN,en;q=0.5', 'en'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT,es;q=0.8', 'es'],
    ['de-AT', 'de'],
    ['xx', 'en'],
    ['', 'en'],
  ])('%s -> %s', (header, lang) => {
    expect(languageFromAcceptLanguage(header)).toBe(lang);
  });

  it.each([
    ['en-US', 'USD'],
    ['en-GB', 'GBP'],
    ['de-DE', 'EUR'],
    ['fr', 'EUR'],
    ['ja', 'JPY'],
    ['zh-HK', 'HKD'],
    ['zh-Hant', 'TWD'],
    ['es-MX', 'USD'],
    ['pt', 'BRL'],
  ])('currency for %s is %s', (tag, cur) => {
    expect(currencyForLocale(tag)).toBe(cur);
  });

  it('initial prefs follow the first tag', () => {
    expect(initialPrefs('ko-KR')).toEqual({ ...DEFAULT_PREFS, language: 'ko', currency: 'KRW' });
    expect(initialPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toMatchObject({ confirmThreshold: 300, theme: 'system', creationMode: 'simple', defaultRatio: '9:16', matureContent: false });
  });
});

describe('prefs patch', () => {
  it('rejects empty, unknown and invalid fields', () => {
    expect(PrefsPatch.safeParse({}).success).toBe(false);
    expect(PrefsPatch.safeParse({ foo: 1 }).success).toBe(false);
    expect(PrefsPatch.safeParse({ notifications: { spam: true } }).success).toBe(false);
    expect(PrefsPatch.safeParse({ theme: 'dark' }).success).toBe(true);
  });

  it('merges notifications and reads rows defensively', () => {
    const next = applyPrefsPatch(DEFAULT_PREFS, { notifications: { product: true }, theme: 'dark' });
    expect(next.notifications).toEqual({ done: true, low: true, renewal: true, product: true });
    const row = prefsFromRow({
      language: 'klingon',
      currency: 'USD',
      creation_mode: 'advanced',
      default_ratio: '9:16',
      default_model: 'auto',
      confirm_threshold: 20,
      notifications: 'not json',
      theme: 'light',
      mature_content: 1,
    });
    expect(row).toMatchObject({ language: 'en', creationMode: 'advanced', confirmThreshold: 20, theme: 'light', matureContent: true, notifications: DEFAULT_PREFS.notifications });
  });
});

describe('roles', () => {
  it('ranks owner > editor > viewer', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
  });
});
