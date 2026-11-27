import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { englishMessages, loadEnglishRest } from './messages';

const list = (file: string) => /@messages\/en\/\{([\w,]+)\}\.json/.exec(readFileSync(new URL(file, import.meta.url), 'utf8'))?.[1];

describe('English split (bundle splitting)', () => {
  it('the rest chunk excludes exactly the first-paint features', () => {
    expect(list('./messages.ts')).toBeTruthy();
    expect(list('./englishRest.ts')).toBe(list('./messages.ts'));
  });

  it('after loadEnglishRest every English feature file is in englishMessages', async () => {
    await loadEnglishRest();
    const all = import.meta.glob<Record<string, string>>(['@messages/en/*.json', '!@messages/en/email.json'], { import: 'default', eager: true });
    for (const [path, messages] of Object.entries(all)) {
      for (const [key, value] of Object.entries(messages)) if (value) expect(englishMessages[key], `${path}: ${key}`).toBe(value);
    }
  });
});
