import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Account flows against a real local backend: `wrangler dev` (apps/api,
 * `ENVIRONMENT=development`, test-inbox email provider, a fresh local D1 per
 * run) behind the production build of the SPA (`VITE_API_MODE=real`) served
 * by `vite preview`, which proxies `/api` (and the WebSocket) to the Worker.
 *
 *   PW_PORT=4932 PW_API_PORT=8932 pnpm exec playwright test -c playwright.account-real.config.ts
 *
 * Stripe is not configured locally: checkout starts answer `503 INTERNAL`,
 * which the specs use for the error path; memberships are seeded in D1
 * (`e2e/account-real/support.ts`).
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
const PORT = Number(process.env.PW_PORT ?? 4932);
const API_PORT = Number(process.env.PW_API_PORT ?? 8932);
const OUT_DIR = `dist-e2e/account-real-${PORT}`;
export const PERSIST = fileURLToPath(new URL(`./node_modules/.cache/account-real-d1-${API_PORT}`, import.meta.url));
export const INBOX_TOKEN = 'e2e-inbox-token';

export default defineConfig({
  testDir: './e2e/account-real',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      cwd: '../api',
      // A fresh local database every run (set PW_REAL_KEEP_DB=1 to keep it), migrated, then the Worker.
      command:
        `${process.env.PW_REAL_KEEP_DB ? '' : `rm -rf ${PERSIST} && `}` +
        `pnpm exec wrangler d1 migrations apply rolling-dev --local --persist-to ${PERSIST} && ` +
        `pnpm exec wrangler dev --port ${API_PORT} --inspector-port ${API_PORT + 400} --persist-to ${PERSIST} ` +
        `--var EMAIL_PROVIDER:test-inbox --var TEST_INBOX_TOKEN:${INBOX_TOKEN} --var PUBLIC_APP_URL:http://localhost:${PORT}`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_MODE: 'real', ROLLING_API_ORIGIN: `http://localhost:${API_PORT}` },
    },
  ],
});
