import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Helpers for the account specs against a local Worker (playwright.account-real.config.ts). */
export const API = `http://localhost:${process.env.PW_API_PORT ?? 8932}`;
const PERSIST = fileURLToPath(new URL(`../../node_modules/.cache/account-real-d1-${process.env.PW_API_PORT ?? 8932}`, import.meta.url));
const API_DIR = fileURLToPath(new URL('../../../api/', import.meta.url));
const INBOX_TOKEN = 'e2e-inbox-token';

let seq = 0;
export function freshEmail(tag = 'e2e'): string {
  seq += 1;
  return `${tag}.${Date.now().toString(36)}.${seq}@example.com`;
}

/** Latest sign-in code sent to `email` after `after` (test-inbox provider; the queue delivers within seconds). */
export async function codeFor(request: APIRequestContext, email: string, after = 0): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const r = await request.get(`${API}/api/test/inbox?to=${encodeURIComponent(email)}&limit=5`, { headers: { authorization: `Bearer ${INBOX_TOKEN}` } });
        const body = (await r.json()) as { messages: { code: string; sentAt: number }[] };
        code = body.messages.find((m) => m.sentAt > after)?.code ?? '';
        return code;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .not.toBe('');
  return code;
}

/** Email-code sign-in through the UI. */
export async function signIn(page: Page, email: string, from = '/login') {
  await page.goto(from);
  await page.getByLabel('Email').fill(email);
  const sentAt = Date.now() - 1000;
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await expect(page.getByTestId('auth-code')).toBeVisible();
  const code = await codeFor(page.request, email, sentAt);
  await page.getByLabel('Verification code').locator('input').fill(code);
}

/** Runs SQL on the local D1 the Worker uses (seeding plans; Stripe is not configured locally). */
export function d1(sql: string) {
  execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'rolling-dev', '--local', '--persist-to', PERSIST, '--command', sql], { cwd: API_DIR, stdio: 'pipe' });
}

/** Gives a workspace an active plan for 30 days. */
export function seedPlan(workspaceId: string, plan: 'starter' | 'plus' | 'pro' | 'team', seats = 1) {
  const now = Date.now();
  d1(
    `INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at, current_period_start, seats) VALUES ('sub_${now.toString(36)}', '${workspaceId}', '${plan}', 'month', 'active', ${now + 30 * 86_400_000}, 0, ${now}, ${now}, ${seats})`,
  );
}

export async function me(page: Page): Promise<{ workspace: { id: string }; prefs: Record<string, unknown>; isMember: boolean }> {
  const r = await page.request.get('/api/me');
  expect(r.ok()).toBe(true);
  return (await r.json()) as never;
}
