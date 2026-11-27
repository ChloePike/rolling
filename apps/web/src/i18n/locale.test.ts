import { describe, expect, it } from 'vitest';
import { matchLocale, resolveLocale, SUPPORTED_LOCALES } from './locale';

const supported = SUPPORTED_LOCALES;

describe('resolveLocale', () => {
  it('prefers the saved preference over the browser languages', () => {
    expect(resolveLocale('ja', ['ko-KR', 'en-US'], supported)).toBe('ja');
  });
  it('falls back to the first supported browser language', () => {
    expect(resolveLocale(null, ['fr-FR', 'zh-TW', 'en'], supported)).toBe('zh-TW');
  });
  it('matches by base language when the region is not supported', () => {
    expect(resolveLocale(undefined, ['ko-KR'], supported)).toBe('ko');
    expect(resolveLocale(undefined, ['ja-JP'], supported)).toBe('ja');
  });
  it('ignores an unsupported or malformed preference', () => {
    expect(resolveLocale('xx_bad tag', ['ja-JP'], supported)).toBe('ja');
    expect(resolveLocale('fr', ['ko'], supported)).toBe('ko');
  });
  it('defaults to English', () => {
    expect(resolveLocale(null, ['fr-FR', 'de'], supported)).toBe('en');
    expect(resolveLocale(null, [], ['en'])).toBe('en');
  });
});

describe('matchLocale: Chinese by script, then region', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hant-CN', 'zh-TW'],
  ])('%s -> %s', (tag, want) => {
    expect(matchLocale(tag, supported)).toBe(want);
  });
  it('never maps Simplified to Traditional when only Traditional is offered', () => {
    expect(matchLocale('zh-CN', ['en', 'zh-TW'])).toBeNull();
  });
});
