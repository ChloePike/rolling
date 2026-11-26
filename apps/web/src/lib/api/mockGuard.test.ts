import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mockData } from './mode';

/**
 * Real mode must never render mock data. Mock modules (`mocks.ts`,
 * `*Mocks.ts`, the mock session `lib/session/mock.ts`, the mock ProjectRoom and
 * mock waveform peaks) may be imported only by the mock-mode adapter's registry
 * (`lib/api/mockData.ts`, loaded on demand by `loadMockData()` in mock builds),
 * by other mock modules and by tests. Everything else reads them through
 * `mockData()`, which throws outside mock mode. Type-only imports are fine:
 * they are erased at build time.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ADAPTER = 'lib/api/mockData.ts';
const MOCK_FILE = /(^|\/)(mocks|[A-Za-z]+Mocks|mock|mockRoom|mockPeaks)\.tsx?$/;
/**
 * Files handed to another owner mid-change (the tools pages, 2026-11): they
 * still import their own mocks and are tracked to be moved behind the adapter.
 * Remove entries as they are fixed; nothing may be added here.
 */
const PENDING = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    try {
      if (statSync(base + ext).isFile()) return base + ext;
    } catch {
      /* Try the next extension. */
    }
  }
  return null;
}

/** Value imports and re-exports (static and dynamic); `import type` / all-`type` specifier lists are skipped. */
function valueImports(code: string): string[] {
  const specs: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(stmt)) {
    const clause = m[2]!.trim();
    if (/^type\s/.test(clause)) continue;
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces && braces[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    specs.push(m[3]!);
  }
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specs.push(m[1]!);
  return specs;
}

const rel = (p: string) => relative(SRC, p).split('\\').join('/');

describe('mock data guard', () => {
  it('only the mock-mode adapter (and mocks and tests) import mock modules', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const r = rel(file);
      if (/\.test\.tsx?$/.test(r) || r === 'test-setup.ts' || r === ADAPTER || MOCK_FILE.test(r) || PENDING.has(r)) continue;
      const code = readFileSync(file, 'utf8');
      for (const spec of valueImports(code)) {
        const target = resolveSpec(file, spec);
        if (target && MOCK_FILE.test(rel(target))) offenders.push(`${r} → ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the adapter registry is reached only through loadMockData()', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const r = rel(file);
      if (/\.test\.tsx?$/.test(r) || r === 'lib/api/mode.ts') continue;
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        const target = resolveSpec(file, spec);
        if (target && rel(target) === ADAPTER) offenders.push(r);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner sees value imports and skips type-only ones', () => {
    expect(valueImports("import { a, type B } from './mocks';\nimport type { C } from './mocks';\nimport { type D } from '../x/mocks';\nexport { e } from './fooMocks';\nconst m = import('./mockData');")).toEqual(['./mocks', './fooMocks', './mockData']);
  });
});

describe('mockData()', () => {
  afterEach(() => {
    delete (globalThis as { __rollingApiMode?: string }).__rollingApiMode;
  });

  it('hands out the mock modules in mock mode', () => {
    expect(mockData().home.MOCK_PROJECTS.length).toBeGreaterThan(0);
  });

  it('throws in real mode, so a real render can never show demo data', () => {
    (globalThis as { __rollingApiMode?: string }).__rollingApiMode = 'real';
    expect(() => mockData()).toThrow(/outside mock mode/);
  });
});
