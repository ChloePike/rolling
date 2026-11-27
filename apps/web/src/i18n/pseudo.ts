import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js';
import type { Messages } from './merge';

/**
 * Pseudo-locale `en-XA` (mock builds only): every literal becomes about 40% longer and
 * uses wide accented letters, in brackets, so overflow and hard-coded strings show up in
 * screenshots. Placeholders, plurals, selects and tags stay intact.
 */
export const PSEUDO_LOCALE = 'en-XA';

const MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

function stretch(text: string): string {
  let out = '';
  let vowels = 0;
  for (const ch of text) {
    out += MAP[ch] ?? ch;
    // Doubling some vowels adds about 40% to typical English copy.
    if ('aeiouAEIOU'.includes(ch) && vowels++ % 2 === 0) out += MAP[ch] ?? ch;
  }
  return out;
}

function walk(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((el) => {
    if (el.type === TYPE.literal) return { ...el, value: stretch(el.value) };
    if (el.type === TYPE.tag) return { ...el, children: walk(el.children) };
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      const options = Object.fromEntries(Object.entries(el.options).map(([k, o]) => [k, { ...o, value: walk(o.value) }]));
      return { ...el, options } as MessageFormatElement;
    }
    return el;
  });
}

export function pseudoMessage(message: string): string {
  try {
    return `[${printAST(walk(parse(message)))}]`;
  } catch {
    return message;
  }
}

let cached: { source: Messages; out: Messages } | null = null;
export function pseudoMessages(source: Messages): Messages {
  if (cached?.source === source) return cached.out;
  const out = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, pseudoMessage(v)]));
  cached = { source, out };
  return out;
}
