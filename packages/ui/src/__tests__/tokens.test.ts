import { describe, expect, it } from 'vitest';
import css from '../../tokens.css?raw';

/**
 * D-010: contrast of text tokens on surface tokens, for both themes. Parses
 * tokens.css: `:root` is dark; light = dark plus the light overrides.
 */

type Theme = Record<string, string>;

function block(source: string, selector: string): string {
  const at = source.indexOf(selector);
  if (at < 0) throw new Error(`missing ${selector}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector}`);
}

function decls(body: string): Theme {
  const out: Theme = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const dark = decls(block(css, ':root{'));
const mediaLight = decls(block(block(css, '@media (prefers-color-scheme:light)'), ':root:not([data-theme="dark"])'));
const attrLight = decls(block(css, ':root[data-theme="light"]'));
const light: Theme = { ...dark, ...attrLight };

type Rgba = [number, number, number, number];

function resolve(theme: Theme, name: string): string {
  let v = theme[name];
  for (let i = 0; v && v.startsWith('var(') && i < 8; i++) v = theme[v.slice(4, -1).trim()];
  if (!v) throw new Error(`unknown token ${name}`);
  return v;
}

function parse(theme: Theme, value: string): Rgba {
  const v = value.trim();
  if (v.startsWith('--') || v.startsWith('var(')) return parse(theme, resolve(theme, v.startsWith('var(') ? v.slice(4, -1).trim() : v));
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1]!.split(',').map((s) => s.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const [r, g, b, a] = parse(theme, mix[1]!);
    return [r, g, b, a * (Number(mix[2]) / 100)];
  }
  throw new Error(`cannot parse color ${v}`);
}

/** Composites `top` over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast of `fg` on `bg`; each may be a stack (top first) composited over the last, opaque one. */
function contrast(theme: Theme, fg: string, bg: string[]): number {
  let base = parse(theme, bg[bg.length - 1]!);
  for (let i = bg.length - 2; i >= 0; i--) base = over(parse(theme, bg[i]!), base);
  const text = over(parse(theme, fg), base);
  const [hi, lo] = [luminance(text), luminance(base)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['--c-bg', '--c-surface-1', '--c-surface-2', '--c-surface-3', '--c-surface-4', '--c-surface-5', '--c-surface-6', '--c-surface-float'];

interface Pair {
  fg: string;
  bg: string[];
  /** Minimum ratio; default WCAG AA for body text (4.5). */
  min?: number;
}

function pairs(theme: 'dark' | 'light'): Pair[] {
  const list: Pair[] = [];
  for (const t of ['--c-text-1', '--c-text-2', '--c-text-3']) for (const s of SURFACES) list.push({ fg: t, bg: [s] });
  // Hints and meta. The approved dark design puts text-4 at 4.1–4.4 on surfaces 2–4; it stays pixel-identical.
  for (const s of ['--c-bg', '--c-surface-1']) list.push({ fg: '--c-text-4', bg: [s] });
  for (const s of ['--c-surface-2', '--c-surface-3', '--c-surface-4', '--c-surface-float']) list.push({ fg: '--c-text-4', bg: [s], min: theme === 'dark' ? 4.0 : 4.5 });
  for (const t of ['--c-accent-text', '--c-link', '--c-danger', '--c-success', '--c-warning', '--c-upgrade', '--c-generating', '--c-failed'])
    for (const s of ['--c-bg', '--c-surface-2', '--c-surface-4', '--c-surface-float']) list.push({ fg: t, bg: [s] });
  // State chips: text on its soft fill, on a card and in a popover.
  const chips: Array<[string, string]> = [
    ['--c-link', '--c-accent-soft'],
    ['--c-accent-text', '--c-accent-soft'],
    ['--c-link', '--c-info-soft'],
    ['--c-success', '--c-success-soft'],
    ['--c-warning', '--c-warning-soft'],
    ['--c-warning-text', '--c-warning-bg'],
    ['--c-upgrade', '--c-upgrade-soft'],
    ['--c-failed', '--c-failed-soft'],
    ['--c-failed-text', '--c-failed-bg'],
    ['--c-danger-strong', '--c-failed-soft'],
  ];
  for (const [fg, soft] of chips) for (const s of ['--c-surface-2', '--c-surface-float']) list.push({ fg, bg: [soft, s] });
  // Primary buttons: bg-colored text on a text-1 fill, and on its hover fill.
  list.push({ fg: '--c-bg', bg: ['--c-text-1'] }, { fg: '--c-bg', bg: ['--c-primary-hover'] }, { fg: '--c-bg', bg: ['--c-primary-badge'] });
  // Editor clip labels and waveforms (waveforms are graphics: 3:1).
  for (const clip of ['--c-clip-video', '--c-clip-video-2', '--c-clip-voice', '--c-clip-music', '--c-clip-caption']) list.push({ fg: '--c-tl-label', bg: [clip] });
  list.push({ fg: '--c-wave-voice', bg: ['--c-clip-voice'], min: 3 }, { fg: '--c-wave-music', bg: ['--c-clip-music'], min: 3 });
  // Chips on media placeholders: text-1 on the frosted chip over a tone.
  for (const tone of ['--c-tone-indigo', '--c-tone-sand', '--c-tone-teal', '--c-tone-plum']) list.push({ fg: '--c-text-1', bg: ['--c-media-chip', tone] });
  return list;
}

describe('tokens.css themes (D-010)', () => {
  it('has identical light blocks for the system preference and the data-theme override', () => {
    expect(mediaLight).toEqual(attrLight);
  });

  it('defines every light token in the dark :root too (no theme-only names)', () => {
    for (const name of Object.keys(attrLight)) expect(dark, name).toHaveProperty(name);
  });

  it('keeps the accent and brand colors', () => {
    expect(light['--c-accent']).toBe('#3B82F6');
    expect(dark['--c-accent']).toBe('#3B82F6');
    expect(light['--c-brand']).toBe('#FFCB2B');
  });

  for (const [name, theme] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    it(`${name}: text tokens meet their contrast minimum on their surfaces`, () => {
      const failures: string[] = [];
      for (const p of pairs(name)) {
        const ratio = contrast(theme, p.fg, p.bg);
        if (ratio < (p.min ?? 4.5)) failures.push(`${p.fg} on ${p.bg.join(' over ')}: ${ratio.toFixed(2)} < ${p.min ?? 4.5}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
