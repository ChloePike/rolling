import { describe, expect, it } from 'vitest';
import { check, firstLoad, mockModules, type ChunkInfo } from './bundleBudget';

const R = '/repo/apps/web/src/routes';
const chunk = (fileName: string, gzip: number, o: Partial<ChunkInfo> = {}): ChunkInfo => ({
  fileName,
  isEntry: false,
  imports: [],
  dynamicImports: [],
  facadeModuleId: null,
  moduleIds: [],
  raw: gzip * 3,
  gzip,
  ...o,
});

const chunks: ChunkInfo[] = [
  chunk('index.js', 100_000, { isEntry: true, imports: ['react.js'], dynamicImports: ['home.js', 'shell.js', 'canvas.js'], moduleIds: ['/repo/apps/web/src/main.tsx'] }),
  chunk('react.js', 50_000),
  // The layout's split module merged into a shared chunk (no facade).
  chunk('shell.js', 10_000, { imports: ['ui.js'], dynamicImports: ['menu.js'], moduleIds: [`${R}/_shell.tsx?tsr-split=component`, '/repo/apps/web/src/shell/Header.tsx'] }),
  chunk('home.js', 30_000, { imports: ['ui.js', 'react.js'], facadeModuleId: `${R}/_shell/index.tsx?tsr-split=component`, moduleIds: [`${R}/_shell/index.tsx?tsr-split=component`] }),
  chunk('ui.js', 5_000),
  chunk('menu.js', 7_000),
  chunk('canvas.js', 400_000, { facadeModuleId: `${R}/p/$projectId.tsx?tsr-split=component`, moduleIds: [`${R}/p/$projectId.tsx?tsr-split=component`] }),
  chunk('homeError.js', 9_000, { moduleIds: [`${R}/_shell/index.tsx?tsr-split=errorComponent`] }),
];

describe('bundle budget', () => {
  it('counts the entry, the route render splits and their static imports, once each', () => {
    const load = firstLoad(chunks, { name: 'Home', routes: ['_shell.tsx', '_shell/index.tsx'] });
    expect(load.files).toEqual(['home.js', 'index.js', 'react.js', 'shell.js', 'ui.js']);
    expect(load.gzip).toBe(195_000);
  });

  it('leaves out lazy layers, other routes and error splits', () => {
    const load = firstLoad(chunks, { name: 'Home', routes: ['_shell.tsx', '_shell/index.tsx'] });
    expect(load.files).not.toContain('menu.js');
    expect(load.files).not.toContain('canvas.js');
    expect(load.files).not.toContain('homeError.js');
  });

  it('fails above the target plus the allowance only', () => {
    const budgets = [{ name: 'Home', routes: [], targetKb: 200 }];
    expect(check([{ name: 'Home', files: [], raw: 0, gzip: 203_999 }], budgets, 0.02)).toEqual([]);
    expect(check([{ name: 'Home', files: [], raw: 0, gzip: 204_001 }], budgets, 0.02)).toHaveLength(1);
    expect(check([], budgets, 0.02)).toHaveLength(1);
  });

  it('finds mock modules in the output', () => {
    const out = [
      chunk('a.js', 1, {
        moduleIds: [
          '/repo/apps/web/src/features/home/mocks.ts',
          '/repo/apps/web/src/features/library/assetsMocks.ts',
          '/repo/apps/web/src/lib/session/mock.ts',
          '/repo/apps/web/src/lib/api/mockData.ts',
          '/repo/apps/web/src/lib/api/mode.ts',
          '/repo/apps/web/src/lib/transfers/mockApi.ts',
          '/repo/node_modules/x/mocks.ts',
        ],
      }),
    ];
    expect(mockModules(out)).toEqual([
      '/repo/apps/web/src/features/home/mocks.ts',
      '/repo/apps/web/src/features/library/assetsMocks.ts',
      '/repo/apps/web/src/lib/session/mock.ts',
      '/repo/apps/web/src/lib/api/mockData.ts',
    ]);
  });
});
