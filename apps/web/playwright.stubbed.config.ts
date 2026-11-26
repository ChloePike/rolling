import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Real-mode loading states (no mock data, ever): the production build of the
 * SPA (real API mode, no `VITE_API_MODE`) served by `vite preview`, with every
 * `/api` call answered by Playwright route stubs after a delay with empty data
 * (`e2e/stubbed-real/support.ts`). No backend runs.
 *
 *   PW_PORT=4961 pnpm exec playwright test -c playwright.stubbed.config.ts
 *
 * The default config's `chromium` project ignores this folder (`/real\//`).
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
const PORT = Number(process.env.PW_PORT ?? 4961);
const OUT_DIR = `dist-e2e/stubbed-${PORT}`;

export default defineConfig({
  testDir: './e2e/stubbed-real',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    // The realtime SharedWorker would bypass the page's route stubs.
    serviceWorkers: 'block',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    // Real mode: nothing listens on the proxy target; the specs stub every /api request in the page.
    command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && ROLLING_API_ORIGIN=http://127.0.0.1:9 pnpm exec vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_API_MODE: 'real' },
  },
});
