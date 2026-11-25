/**
 * Which backend the app talks to. Production and staging builds use the real
 * API (`/api`, same origin). `VITE_API_MODE=mock` (the Playwright fidelity and
 * flow specs, and unit tests by default) keeps every client on its in-memory
 * mocks and test seams (`window.__rollingMocks`).
 *
 * Unit tests of the real path set `globalThis.__rollingApiMode = 'real'`.
 */
export type ApiMode = 'real' | 'mock';

export function apiMode(): ApiMode {
  const override = (globalThis as { __rollingApiMode?: ApiMode }).__rollingApiMode;
  if (override === 'real' || override === 'mock') return override;
  return import.meta.env?.VITE_API_MODE === 'mock' ? 'mock' : 'real';
}

export const isMockApi = (): boolean => apiMode() === 'mock';
