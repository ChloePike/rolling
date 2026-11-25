#!/usr/bin/env node
/**
 * D-010: no hard-coded colors in components. Every color is a token from
 * packages/ui/tokens.css (which defines both themes), so light mode cannot
 * miss a spot. Scans apps/web/src and packages/ui (CSS, TS, TSX) for hex,
 * rgb()/rgba()/hsl()/hsla() and named colors, and fails on any match outside
 * the allowlist below. No dependencies; run with `node scripts/check-colors.mjs`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['apps/web/src', 'packages/ui/src', 'packages/ui/base.css'];
const EXTENSIONS = ['.css', '.ts', '.tsx'];

/**
 * Allowed exceptions: `file` is a path (or path prefix) from the repo root,
 * `match` an optional regex the offending text must match. Keep each one
 * justified; everything else belongs in tokens.css.
 */
const ALLOW = [
  { file: 'packages/ui/tokens.css', reason: 'the token definitions themselves' },
  { file: 'apps/web/src/features/auth/LoginPage.tsx', match: /^#(4285F4|34A853|FBBC05|EA4335)$/i, reason: 'Google sign-in logo (brand asset)' },
  { file: 'apps/web/src/features/canvas/editor/TimelineCanvas.tsx', match: /^rgba\(\$\{C\.hoverRgb\}/, reason: 'hover alpha on the --c-tl-hover-rgb token' },
  { test: /\.test\.tsx?$/, reason: 'test fixtures' },
];

const NAMED =
  'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta|brown|beige|ivory|coral|crimson|indigo|violet|khaki|salmon|tomato|orchid|plum|tan|wheat|azure|lavender|chartreuse';
const PATTERNS = [
  /(?<![\w&$-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b(?![\w-])/g,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[^()]|\([^()]*\))*\)/g,
];
/** Named colors only where a color is expected: CSS color properties, and color props/keys in TS. */
const NAMED_CSS = new RegExp(String.raw`(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|border|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration-color)\s*:[^;{}]*?\b(${NAMED})\b`, 'gi');
const NAMED_TS = new RegExp(String.raw`\b(?:color|background(?:Color)?|borderColor|outlineColor|fill|stroke|boxShadow)\s*[:=]\s*\{?\s*['"\`]([^'"\`]*\b(?:${NAMED})\b[^'"\`]*)['"\`]`, 'gi');

function walk(path, out) {
  const abs = join(REPO, path);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (EXTENSIONS.some((e) => abs.endsWith(e))) out.push(abs);
    return;
  }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    walk(join(path, name), out);
  }
}

/** Blanks out comments (keeping line numbers) so documented values do not count. */
function stripComments(text, isCss) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!isCss) out = out.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
  return out;
}

function allowed(file, found) {
  return ALLOW.some((a) => {
    if (a.test && !a.test.test(file)) return false;
    if (a.file && file !== a.file && !file.startsWith(a.file.endsWith('/') ? a.file : a.file + '/')) return false;
    return !a.match || a.match.test(found);
  });
}

const files = [];
for (const r of ROOTS) walk(r, files);
const problems = [];
for (const abs of files) {
  const file = relative(REPO, abs).split(sep).join('/');
  const isCss = file.endsWith('.css');
  const text = stripComments(readFileSync(abs, 'utf8'), isCss);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const hits = [];
    for (const re of PATTERNS) for (const m of line.matchAll(re)) hits.push(m[0]);
    // Custom property names (var(--c-tone-indigo)) are not named colors.
    const named = line.replace(/--[\w-]+/g, (m) => ' '.repeat(m.length));
    for (const m of named.matchAll(isCss ? NAMED_CSS : NAMED_TS)) hits.push(m[1]);
    for (const h of hits) if (!allowed(file, h)) problems.push(`${file}:${i + 1}: ${h}`);
  });
}

if (problems.length) {
  console.error(`check-colors: ${problems.length} hard-coded color(s). Use a token from packages/ui/tokens.css (add one, with a light value, if none fits), or allowlist it in apps/web/scripts/check-colors.mjs with a reason.\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-colors: ${files.length} files, no hard-coded colors.`);
