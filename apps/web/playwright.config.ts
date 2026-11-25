import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium is preinstalled in this environment (no `playwright install`).
 * Set PW_CHROMIUM_PATH to override; otherwise Playwright's own browser is used
 * when present, falling back to the preinstalled build.
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
const PORT = Number(process.env.PW_PORT ?? 4173);
/**
 * Tests build into their own folder (one per port) so `pnpm build` writing
 * `dist` for the Worker, or another Playwright run on a different port, can
 * never wipe the files the preview server is serving.
 */
const OUT_DIR = `dist-e2e/${PORT}`;

/**
 * `real` project (docs/canvas-flow.md against a real backend, no mocks):
 * - `PW_BASE_URL=https://<staging>` runs it against a deployed Worker (no local server);
 * - `PW_REAL_LOCAL=1` starts `wrangler dev` (ENVIRONMENT=development, test inbox) on `PW_REAL_API_PORT` and the
 *   real-mode SPA on `PW_REAL_PORT` (set `TEST_INBOX_TOKEN`; generation and agent steps skip without a gateway).
 * The default `chromium` project runs every other spec on the mocks (`VITE_API_MODE=mock`).
 */
const REAL_BASE = process.env.PW_BASE_URL;
const REAL_LOCAL = process.env.PW_REAL_LOCAL === '1';
const REAL_PORT = Number(process.env.PW_REAL_PORT ?? 4797);
const REAL_API_PORT = Number(process.env.PW_REAL_API_PORT ?? 8797);
const realBaseURL = REAL_BASE ?? `http://localhost:${REAL_PORT}`;
const onlyReal = !!REAL_BASE || REAL_LOCAL;

export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'chromium', testIgnore: /real\// },
    { name: 'real', testDir: './e2e/real', use: { baseURL: realBaseURL }, timeout: 15 * 60_000 },
  ],
  webServer: onlyReal
    ? REAL_LOCAL
      ? [
          {
            // The Worker on wrangler dev: development identity, test inbox for email-code sign-in, local D1 (migrated first).
            command: `cd ../api && pnpm exec wrangler d1 migrations apply rolling-dev --local && pnpm exec wrangler dev --port ${REAL_API_PORT} --var ENVIRONMENT:development --var EMAIL_PROVIDER:test-inbox --var TEST_INBOX_TOKEN:${process.env.TEST_INBOX_TOKEN ?? 'e2e-local'} --var PUBLIC_APP_URL:http://localhost:${REAL_PORT}`,
            url: `http://localhost:${REAL_API_PORT}/api/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 240_000,
          },
          {
            // The SPA in real mode in its own folder (never apps/web/dist), proxying /api (and the socket) to the Worker.
            command: `pnpm exec vite build --outDir dist-e2e/real --emptyOutDir && ROLLING_API_ORIGIN=http://localhost:${REAL_API_PORT} pnpm exec vite preview --outDir dist-e2e/real --port ${REAL_PORT} --strictPort`,
            url: `http://localhost:${REAL_PORT}`,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ]
      : undefined
    : {
        command: `VITE_API_MODE=mock pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
