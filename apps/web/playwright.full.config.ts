import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Full feature suite (docs/test-matrix.md) against a deployed Worker — no local servers, no mocks.
 *
 *   TEST_INBOX_TOKEN=… pnpm --filter @rolling/web exec playwright test -c playwright.full.config.ts --project=full --trace off
 *
 * Env:
 * - `PW_BASE_URL` — staging by default (`https://staging.rolling.actor`): real Hyperouter, the test inbox and `POST /api/test/plan`.
 * - `PW_PROD_URL` — production for the signed-out smoke project `full-prod` (`https://rolling.actor`); never mutates.
 * - `TEST_INBOX_TOKEN` — staging test-inbox bearer token (or `PW_TEST_INBOX_TOKEN_FILE`, a file holding it).
 * - `PW_GENERATE=1` — run the specs that spend real credits on staging (cheap models, low resolution).
 * - `PW_EXPORT=1` — run the FFmpeg export (needs PW_GENERATE for the shots).
 * - `PW_FULL_OUT` — folder for screenshots and the spend log (default `test-results/full`).
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);
const BASE = process.env.PW_BASE_URL ?? 'https://staging.rolling.actor';
const PROD = process.env.PW_PROD_URL ?? 'https://rolling.actor';

export default defineConfig({
  testDir: './e2e/full',
  outputDir: process.env.PW_FULL_OUT ? `${process.env.PW_FULL_OUT}/results` : 'test-results/full',
  fullyParallel: false,
  workers: Number(process.env.PW_WORKERS ?? 4),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: `${process.env.PW_FULL_OUT ?? 'test-results/full'}/report.json` }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'full', testIgnore: /prod\.spec\.ts/, use: { baseURL: BASE } },
    { name: 'full-prod', testMatch: /prod\.spec\.ts/, use: { baseURL: PROD } },
  ],
});
