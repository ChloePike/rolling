/**
 * Build-time JS size budget (bundle splitting, 2026-11-27).
 *
 * After `vite build` this plugin measures what a first visit to a route downloads
 * before it can render: the entry chunk, the route's split chunks (TanStack
 * Router `autoCodeSplitting`: `routes/<file>.tsx?tsr-split=component`) and every
 * chunk they import statically, gzip-compressed. A budget over its limit fails
 * the build, so CI (`pnpm --filter @rolling/web build`) fails.
 *
 * Real builds also fail when a mock module (`mocks.ts`, `*Mocks.ts`, the mock
 * session, `lib/api/mockData.ts`, …) reaches the output.
 *
 * `ROLLING_BUNDLE_STATS=<file>` writes the per-chunk and per-module numbers as JSON
 * (the before/after measurement). `ROLLING_BUNDLE_BUDGET=off` skips the check.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

export interface ChunkInfo {
  fileName: string;
  isEntry: boolean;
  /** Static imports (file names). */
  imports: string[];
  dynamicImports: string[];
  facadeModuleId: string | null;
  moduleIds: string[];
  raw: number;
  gzip: number;
}

export interface Budget {
  name: string;
  /** Route files, relative to `src/routes`, whose split chunks render this page (layouts included). */
  routes: string[];
  /** Target, in kB (1000 bytes) of gzip-compressed JS. */
  targetKb: number;
}

export interface FirstLoad {
  name: string;
  files: string[];
  raw: number;
  gzip: number;
}

/** Home (`/`): the `_shell` layout and the index page. Target 250 kB gzip (owner, 2026-11-27). */
export const BUDGETS: Budget[] = [{ name: 'Home', routes: ['_shell.tsx', '_shell/index.tsx'], targetKb: 250 }];

/** A small allowance over the target before the build fails, as a fraction of it. */
export const ALLOWANCE = 0.02;

/** The mock modules of `src/lib/api/mockGuard.test.ts`, plus the adapter's registry. */
const MOCK_MODULE = /\/src\/(.+\/)?(mocks|[A-Za-z]+Mocks|mock|mockRoom|mockPeaks|mockData)\.tsx?$/;

/** Split groups (`?tsr-split=component---loader`) that a page needs before it renders. */
const RENDER_SPLITS = new Set(['component', 'loader']);

function routeOf(id: string): { file: string; splits: string[] } | null {
  const m = /\/src\/routes\/(.+?)\?tsr-split=([\w-]+)/.exec(id);
  return m ? { file: m[1]!, splits: m[2]!.split('---') } : null;
}

/** The chunks a page loads before it renders: entry, the routes' render splits, and their static imports. */
export function firstLoad(chunks: ChunkInfo[], budget: Pick<Budget, 'name' | 'routes'>): FirstLoad {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  // A route's split module is usually its chunk's facade, but Rollup may merge it into a shared chunk.
  const roots = chunks.filter(
    (c) =>
      c.isEntry ||
      c.moduleIds.some((id) => {
        const r = routeOf(id);
        return !!r && budget.routes.includes(r.file) && r.splits.some((s) => RENDER_SPLITS.has(s));
      }),
  );
  const seen = new Set<string>();
  const stack = roots.map((c) => c.fileName);
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const i of byName.get(f)?.imports ?? []) if (byName.has(i)) stack.push(i);
  }
  const files = [...seen].sort();
  let raw = 0;
  let gzip = 0;
  for (const f of files) {
    raw += byName.get(f)!.raw;
    gzip += byName.get(f)!.gzip;
  }
  return { name: budget.name, files, raw, gzip };
}

/** Mock modules in the output (must be none in a real build). */
export function mockModules(chunks: ChunkInfo[]): string[] {
  return chunks.flatMap((c) => c.moduleIds.filter((id) => !id.includes('/node_modules/') && MOCK_MODULE.test(id.split('?')[0]!)));
}

/** Failures for these numbers (empty when every budget holds). */
export function check(loads: FirstLoad[], budgets: Budget[] = BUDGETS, allowance = ALLOWANCE): string[] {
  return budgets.flatMap((b) => {
    const load = loads.find((l) => l.name === b.name);
    const limit = b.targetKb * 1000 * (1 + allowance);
    if (!load) return [`${b.name}: no chunks found for routes ${b.routes.join(', ')}`];
    return load.gzip > limit ? [`${b.name}: first-load JS is ${kb(load.gzip)} gzip, over the ${b.targetKb} kB target (+${allowance * 100}% allowance)`] : [];
  });
}

const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;

export function bundleBudget(options: { mockBuild: boolean; budgets?: Budget[] }): Plugin {
  const budgets = options.budgets ?? BUDGETS;
  return {
    name: 'rolling:bundle-budget',
    apply: 'build',
    generateBundle(_out, bundle) {
      // The service worker is its own build (vite-plugin-pwa injectManifest); only the app is measured.
      if (Object.keys(bundle).some((f) => f === 'sw.js')) return;
      const chunks: ChunkInfo[] = [];
      for (const c of Object.values(bundle)) {
        if (c.type !== 'chunk') continue;
        chunks.push({
          fileName: c.fileName,
          isEntry: c.isEntry,
          imports: c.imports,
          dynamicImports: c.dynamicImports,
          facadeModuleId: c.facadeModuleId,
          moduleIds: c.moduleIds,
          raw: Buffer.byteLength(c.code),
          gzip: gzipSync(c.code).length,
        });
      }
      if (!chunks.some((c) => c.isEntry)) return;
      const loads = budgets.map((b) => firstLoad(chunks, b));
      const statsFile = process.env.ROLLING_BUNDLE_STATS;
      if (statsFile) {
        const modules = Object.fromEntries(
          Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? [[c.fileName, Object.fromEntries(Object.entries(c.modules).map(([id, m]) => [id, m.renderedLength]))]] : [])),
        );
        writeFileSync(statsFile, JSON.stringify({ loads, chunks: chunks.map(({ moduleIds: _, ...c }) => c), modules }, null, 1));
      }
      const totalGzip = chunks.reduce((s, c) => s + c.gzip, 0);
      for (const l of loads) this.info(`first load ${l.name}: ${kb(l.gzip)} gzip (${kb(l.raw)} raw) in ${l.files.length} chunks; all JS ${kb(totalGzip)} gzip`);
      if (process.env.ROLLING_BUNDLE_BUDGET === 'off') return;
      const failures = options.mockBuild ? [] : [...check(loads, budgets), ...mockModules(chunks).map((id) => `mock module in a real build: ${id}`)];
      if (failures.length) this.error(`Bundle budget failed:\n  ${failures.join('\n  ')}\n(see apps/web/build/bundleBudget.ts)`);
    },
  };
}
