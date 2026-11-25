import { describe, expect, it } from 'vitest';
import { matchLocale, resolveLocale } from './locale';

const supported = ['en', 'ja', 'zh-TW', 'zh-HK', 'ko'];

describe('resolveLocale', () => {
  it('prefers the saved preference over the browser languages', () => {
    expect(resolveLocale('ja', ['ko-KR', 'en-US'], supported)).toBe('ja');
  });
  it('falls back to the first supported browser language', () => {
    expect(resolveLocale(null, ['fr-FR', 'zh-TW', 'en'], supported)).toBe('zh-TW');
  });
  it('matches by base language when the region is not supported', () => {
    expect(resolveLocale(undefined, ['ko-KR'], supported)).toBe('ko');
  });
  it('ignores an unsupported or malformed preference', () => {
    expect(resolveLocale('xx_bad tag', ['ja-JP'], supported)).toBe('ja');
  });
  it('defaults to English', () => {
    expect(resolveLocale(null, ['fr-FR', 'de'], supported)).toBe('en');
    expect(resolveLocale(null, [], ['en'])).toBe('en');
  });
});

describe('matchLocale', () => {
  it('does not map zh-CN to zh-TW', () => {
    expect(matchLocale('zh-CN', supported)).toBeNull();
  });
});
