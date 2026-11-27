#!/usr/bin/env node
/**
 * Motion tokens only (handoff 7, docs/motion-audit.md). Every transition and
 * animation takes its duration, delay and easing from packages/ui/tokens.css
 * (`--dur-*`, `--m-*`, `--ease-*`) or from `duration` / `easing` in
 * `@rolling/ui` (JS timing), so enter/exit timing stays consistent and the
 * reduced-motion overrides reach everything.
 *
 * Flags, in apps/web/src and packages/ui (CSS, TS, TSX):
 *  - CSS `transition*` / `animation*` declarations with a literal time (`200ms`,
 *    `.3s`) or easing (`ease`, `ease-in-out`, `cubic-bezier(…)`, `steps(…)`);
 *  - the same inside inline style strings and style keys in TS/TSX
 *    (`transition: 'opacity .2s ease'`, `animationDuration: '1s'`);
 *  - `motion` (motion.dev) `transition={{ duration: 0.2, ease: … }}` with literals.
 * `0s`/`0ms`, `none`, `linear` (real progress, loops) and `var(…)` are allowed.
 * No dependencies; run with `node scripts/check-motion.mjs`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['apps/web/src', 'packages/ui/src', 'packages/ui/base.css'];
const EXTENSIONS = ['.css', '.ts', '.tsx'];

/** Allowed exceptions, each with a reason. Everything else uses the tokens. */
const ALLOW = [
  { file: 'packages/ui/tokens.css', reason: 'the token definitions themselves' },
  { file: 'packages/ui/src/motion/index.ts', reason: 'the JS mirror of the tokens' },
  { test: /\.test\.tsx?$/, reason: 'test fixtures' },
  {
    file: 'apps/web/src/features/splash/Splash.module.css',
    reason: 'brand choreography from Splash.dc.html (offsets and the hole/ring/wordmark curves of one 1.15s sequence); its exit and reduced-motion fade use the tokens',
  },
];

const TIME = /(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g;
const EASING = /\b(cubic-bezier\([^)]*\)|steps\([^)]*\)|ease-in-out|ease-in|ease-out|ease|step-start|step-end)(?![\w-])/g;

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

/** Blanks out comments (keeping offsets) so documented values do not count. */
function stripComments(text, isCss) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!isCss) out = out.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
  return out;
}

/** Literal times and easings in a transition/animation value, ignoring var(--…) names. */
function literals(value) {
  const v = value.replace(/--[\w-]+/g, (m) => ' '.repeat(m.length));
  const hits = [];
  for (const m of v.matchAll(TIME)) if (Number(m[1]) !== 0) hits.push(m[0]);
  for (const m of v.matchAll(EASING)) hits.push(m[0]);
  return hits;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const CSS_DECL = /(?:^|[;{\s])((?:-webkit-)?(?:transition|animation)(?:-(?:duration|delay|timing-function))?)\s*:\s*([^;{}]*)/g;
const TS_STYLE = /\b(transition|animation|transitionDuration|transitionDelay|transitionTimingFunction|animationDuration|animationDelay|animationTimingFunction)\s*:\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g;
/**
 * motion.dev: `transition={{ duration: 0.2, ease: … }}`, a `transition: {…}` key, or any object
 * literal that names a tween/spring or an `ease` (e.g. `const SLIDE = { type: 'tween', … }`).
 */
const MOTION_OBJ = /\btransition\s*[=:]\s*\{\{?([^{}]*)\}?\}|\{([^{}]*\b(?:type\s*:\s*['"](?:tween|spring|inertia)['"]|ease\s*:)[^{}]*)\}/g;

export function scanText(file, source) {
  const isCss = file.endsWith('.css');
  const text = stripComments(source, isCss);
  const out = [];
  if (isCss) {
    const local = new Set([...text.matchAll(/@keyframes\s+([\w-]+)/g)].map((k) => k[1]));
    for (const m of text.matchAll(CSS_DECL)) {
      for (const h of literals(m[2])) out.push({ file, line: lineOf(text, m.index), found: `${m[1]}: ${h}` });
      // CSS modules rename keyframe names: a shared rl-* keyframe (base.css) must be written global(rl-…),
      // or the animation silently never runs.
      if (file.endsWith('.module.css') && /^(?:-webkit-)?animation(?:-name)?$/.test(m[1])) {
        const bare = m[2].replace(/global\([^)]*\)/g, ' ').replace(/var\([^)]*\)/g, ' ');
        for (const k of bare.matchAll(/(?<![\w-])(rl-[a-z][\w-]*)/g)) {
          if (!local.has(k[1])) out.push({ file, line: lineOf(text, m.index), found: `${m[1]}: ${k[1]} needs global(${k[1]}) in a CSS module` });
        }
      }
    }
    return out;
  }
  for (const m of text.matchAll(TS_STYLE)) {
    for (const h of literals(m[3])) out.push({ file, line: lineOf(text, m.index), found: `${m[1]}: ${h}` });
    // `${i * 150}ms` computes a time in JS: use calc() with a token instead.
    if (/\}m?s\b/.test(m[3])) out.push({ file, line: lineOf(text, m.index), found: `${m[1]}: computed time ${m[3]}` });
  }
  // Canvas viewport moves (React Flow) are JS-driven: motionMs('slow') gives the token, or 0 under reduced motion.
  for (const m of text.matchAll(/\b(setCenter|fitView|fitBounds|zoomIn|zoomOut|zoomTo|setViewport)\((?:[^()]|\([^()]*\))*?\bduration\s*:\s*(\d+)/g)) {
    if (Number(m[2]) !== 0) out.push({ file, line: lineOf(text, m.index), found: `${m[1]} duration: ${m[2]}` });
  }
  // Exit timers must match the exit token: usePresence(open, duration.fast), not usePresence(open, 140).
  for (const m of text.matchAll(/\busePresence\([^()]*,\s*(\d+)\s*\)/g)) out.push({ file, line: lineOf(text, m.index), found: `usePresence exit: ${m[1]}` });
  for (const m of text.matchAll(MOTION_OBJ)) {
    const body = m[1] ?? m[2] ?? '';
    const dur = /\b(duration|delay)\s*:\s*(\d*\.?\d+)\b/.exec(body);
    if (dur && Number(dur[2]) !== 0) out.push({ file, line: lineOf(text, m.index), found: `motion ${dur[1]}: ${dur[2]}` });
    const ease = /\bease\s*:\s*(\[[^\]]*\]|['"][^'"]*['"])/.exec(body);
    // `ease: 'linear'` is allowed, like CSS `linear`.
    if (ease && !/^['"]linear['"]$/.test(ease[1])) out.push({ file, line: lineOf(text, m.index), found: `motion ease: ${ease[1]}` });
  }
  return out;
}

function allowed(file) {
  return ALLOW.some((a) => {
    if (a.test && !a.test.test(file)) return false;
    if (a.file && file !== a.file && !file.startsWith(a.file.endsWith('/') ? a.file : a.file + '/')) return false;
    return true;
  });
}

export function checkMotion() {
  const files = [];
  for (const r of ROOTS) walk(r, files);
  const problems = [];
  for (const abs of files) {
    const file = relative(REPO, abs).split(sep).join('/');
    if (allowed(file)) continue;
    problems.push(...scanText(file, readFileSync(abs, 'utf8')));
  }
  return { files: files.length, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { files, problems } = checkMotion();
  if (problems.length) {
    console.error(
      `check-motion: ${problems.length} hard-coded duration(s)/easing(s). Use var(--dur-*) / var(--ease-*) / var(--m-*) from packages/ui/tokens.css, or duration/easing from @rolling/ui in JS.\n`,
    );
    for (const p of problems) console.error(`  ${p.file}:${p.line}: ${p.found}`);
    process.exitCode = 1;
  } else {
    console.log(`check-motion: ${files} files, no hard-coded durations or easings.`);
  }
}
