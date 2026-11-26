import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Tool pages in real mode (`VITE_API_MODE=real`, the production client code)
 * with the API stubbed per test (`e2e/tools-real/support.ts`): the catalog,
 * the session, the public library, quotes and runs. No mocks from the mock
 * adapter can render in this build.
 *
 *   PW_PORT=4961 pnpm exec playwright test -c playwright.tools-real.config.ts
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
const PORT = Number(process.env.PW_PORT ?? 4961);
const OUT_DIR = `dist-e2e/tools-real-${PORT}`;

export default defineConfig({
  testDir: './e2e/tools-real',
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // Nothing listens there: every /api request the specs don't stub fails like a missing backend.
    env: { VITE_API_MODE: 'real', ROLLING_API_ORIGIN: 'http://127.0.0.1:9' },
  },
});
