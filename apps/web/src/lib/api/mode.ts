import type { MockData } from './mockData';

/**
 * Which backend the app talks to. Production and staging builds use the real
 * API (`/api`, same origin). `VITE_API_MODE=mock` (the Playwright fidelity and
 * flow specs, and unit tests by default) keeps every client on its in-memory
 * mocks and test seams (`window.__rollingMocks`).
 *
 * Unit tests of the real path set `globalThis.__rollingApiMode = 'real'`.
 *
 * Mock data (every `mocks.ts` / `*Mocks.ts` and the mock session) is reached
 * only through this adapter: `loadMockData()` imports `./mockData` (the one
 * module allowed to import mocks, see `mockGuard.test.ts`) and `mockData()`
 * hands it out, in mock mode only. `MOCK_BUILD` is a build-time constant, so
 * real-mode builds drop the import and never ship the mocks.
 */
export type ApiMode = 'real' | 'mock';

/** True only in `VITE_API_MODE=mock` builds and under Vitest; folds to `false` in real builds. */
export const MOCK_BUILD: boolean = import.meta.env.VITE_API_MODE === 'mock' || import.meta.env.MODE === 'test';

export function apiMode(): ApiMode {
  if (!MOCK_BUILD) return 'real';
  const override = (globalThis as { __rollingApiMode?: ApiMode }).__rollingApiMode;
  if (override === 'real' || override === 'mock') return override;
  return import.meta.env.VITE_API_MODE === 'mock' ? 'mock' : 'real';
}

export const isMockApi = (): boolean => apiMode() === 'mock';

let loaded: MockData | null = null;

/**
 * Loads the mock data (mock builds and tests; a no-op in real builds). The app
 * entry and the Vitest setup await it before anything renders.
 */
export async function loadMockData(): Promise<void> {
  if (MOCK_BUILD && !loaded) loaded = (await import('./mockData')).mockModules;
}

/**
 * The mock data, for mock-mode code paths only. Throws in real mode, so a
 * real-mode render can never show demo content.
 */
export function mockData(): MockData {
  if (!isMockApi()) throw new Error('mockData() read outside mock mode');
  if (!loaded) throw new Error('mockData() read before loadMockData()');
  return loaded;
}
