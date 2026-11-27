import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntl } from 'react-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPrice } from '@/lib/prefs/currency';
import { LANGUAGE_OPTIONS, languageOption } from '@/lib/prefs';
import { checkMessages, duplicateKeys } from '../../scripts/check-messages.mjs';
import { SUPPORTED_LOCALES } from './locale';
import { englishMessages, loadLocaleMessages, loadMessages } from './messages';
import { pseudoMessage } from './pseudo';

describe('message catalogs (D-023)', () => {
  it('every locale parses, has no extra keys and keeps the English arguments', () => {
    const { errors, locales } = checkMessages();
    expect(errors).toEqual([]);
    for (const l of SUPPORTED_LOCALES.filter((l) => l !== 'en')) expect(locales).toContain(l);
  });

  it('every supported locale is listed in its own script and loads as its own chunk', async () => {
    for (const tag of SUPPORTED_LOCALES) {
      const option = languageOption(tag);
      expect(option?.tag).toBe(tag);
      expect(option?.translated).toBe(true);
      const own = await loadLocaleMessages(tag);
      expect(Object.keys(own).length).toBeGreaterThan(0);
    }
    expect(LANGUAGE_OPTIONS.map((o) => o.name)).toEqual(expect.arrayContaining(['English', '简体中文', '繁體中文', '日本語', '한국어']));
    // Email templates are the Worker's, not the SPA's.
    expect(Object.keys(englishMessages).some((k) => k.startsWith('email.'))).toBe(false);
  });

  it('falls back to English per key', async () => {
    const ja = await loadMessages('ja');
    expect(Object.keys(ja).length).toBeGreaterThanOrEqual(Object.keys(englishMessages).length);
    for (const key of Object.keys(englishMessages)) expect(typeof ja[key]).toBe('string');
  });

  it('flags extra keys, duplicates and ICU errors, and only warns on missing keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgs-'));
    mkdirSync(join(dir, 'en'));
    mkdirSync(join(dir, 'xx'));
    writeFileSync(join(dir, 'en', 'a.json'), JSON.stringify({ 'a.one': 'Hi {name}', 'a.two': '{n, plural, one {# file} other {# files}}', 'a.three': 'Three' }));
    writeFileSync(join(dir, 'xx', 'a.json'), '{"a.one": "Yo {nom}", "a.two": "{n, plural, other {# x}", "a.extra": "E", "a.one": "dup"}');
    const { errors, warnings, report } = checkMessages(dir);
    expect(errors.join('\n')).toMatch(/duplicate key a\.one/);
    expect(errors.join('\n')).toMatch(/extra key a\.extra/);
    expect(errors.join('\n')).toMatch(/a\.two: ICU syntax error/);
    expect(report.xx?.missing).toContain('a.three');
    expect(warnings.join('\n')).toMatch(/missing key/);
    expect(duplicateKeys('{"k": "{\\"k\\": 1}", "j": 2}')).toEqual([]);
  });
});

describe('Intl formatting follows the active locale; prices stay USD (D-019)', () => {
  const fmt = (locale: string) => createIntl({ locale, messages: {} });
  it('formats USD prices with the locale separators and symbol', () => {
    expect(formatPrice(fmt('en'), 1234.5)).toBe('$1,234.50');
    expect(formatPrice(fmt('ja'), 1234.5)).toBe('$1,234.50');
    expect(formatPrice(fmt('ko'), 12)).toBe('US$12');
    expect(formatPrice(fmt('zh-CN'), 12)).toBe('US$12');
    expect(formatPrice(fmt('zh-TW'), 12)).toBe('US$12');
    expect(formatPrice(fmt('de'), 1234.5)).toMatch(/1\.234,50\s\$/);
    // Tight top-up tiles: the narrow symbol in every language.
    expect(formatPrice(fmt('ko'), 250, undefined, { narrow: true })).toBe('$250');
  });
  it('formats dates and plurals in the locale', () => {
    const d = new Date(Date.UTC(2026, 10, 27, 12));
    expect(fmt('ja').formatDate(d, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('2026年11月27日');
    expect(fmt('ko').formatDate(d, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('2026년 11월 27일');
    expect(fmt('zh-CN').formatDate(d, { month: 'short', day: 'numeric', timeZone: 'UTC' })).toBe('11月27日');
    expect(createIntl({ locale: 'ja', messages: { m: '{n, plural, other {#件}}' } }).formatMessage({ id: 'm' }, { n: 1 })).toBe('1件');
  });
});

describe('locale switch', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('follows the preference, then the browser, then English', async () => {
    const { stateFor } = await import('./I18nProvider');
    vi.stubGlobal('navigator', { languages: ['ko-KR', 'en'], language: 'ko-KR' });
    expect((await stateFor(null)).lang).toBe('ko');
    const ja = await stateFor('ja');
    expect(ja).toMatchObject({ locale: 'ja', lang: 'ja' });
    expect(ja.messages['app.name']).toBeDefined();
    expect((await stateFor('zh-HK')).lang).toBe('zh-TW');
    // A listed but untranslated language: English text, its own formats, <html lang="en">.
    const de = await stateFor('de');
    expect(de).toMatchObject({ locale: 'de', lang: 'en' });
    expect(de.messages).toBe(englishMessages);
    vi.stubGlobal('navigator', { languages: ['fr-FR'], language: 'fr-FR' });
    expect((await stateFor(null)).lang).toBe('en');
  });
});

describe('pseudo-locale', () => {
  it('stretches literals and keeps ICU arguments, plurals and tags', () => {
    const out = pseudoMessage('Delete {count, plural, one {# file} other {# files}} in <b>{name}</b>');
    expect(out.startsWith('[') && out.endsWith(']')).toBe(true);
    expect(out).toContain('{count,plural');
    expect(out).toContain('{name}');
    expect(out).toContain('<b>');
    const intl = createIntl({ locale: 'en', messages: { m: out } });
    const text = intl.formatMessage({ id: 'm' }, { count: 2, name: 'x', b: (c) => c.join('') });
    expect(text).toContain('2');
    expect(text.length).toBeGreaterThan('Delete 2 files in x'.length * 1.2);
  });
});
