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
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `pnpm build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
