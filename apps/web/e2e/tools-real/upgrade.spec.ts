import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { ME, stubApi } from './support';

/**
 * The upgrade modal against the real client (`VITE_API_MODE=real`) with a
 * stubbed API: Stripe Checkout opens in a popup, the popup's return page tells
 * the app and closes, `/api/me` refetches and the picked 1080p applies, with
 * the page URL unchanged throughout. Without Stripe keys the modal shows its
 * "Payments aren't available yet" notice under the reason headline.
 */

const PREFS = { ...ME.prefs, creationMode: 'advanced' };
const NON_MEMBER = { ...ME, prefs: PREFS, plan: null, isMember: false, workspaces: ME.workspaces.map((w) => ({ ...w, plan: null })) };
const PLUS = { ...ME, prefs: PREFS, plan: { ...ME.plan, id: 'plus', label: 'Plus', perks: { ...ME.plan.perks, maxVideoResolution: '1080p', monthlyCredits: 800 } }, workspaces: ME.workspaces.map((w) => ({ ...w, plan: 'plus' })) };

async function billing(page: Page, context: BrowserContext, opts: { paymentsEnabled: boolean }) {
  const state = { me: NON_MEMBER as unknown, checkout: null as Record<string, unknown> | null, paid: false };
  await stubApi(page, context, { creationMode: 'advanced' });
  // Registered after stubApi, so these answer first.
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/me') return route.fulfill({ json: state.paid ? PLUS : state.me });
    if (path === '/billing/plans') return route.fulfill({ json: { plans: [], paymentsEnabled: opts.paymentsEnabled, current: { plan: null, isMember: false } } });
    if (path === '/billing/checkout' && req.method() === 'POST') {
      if (!opts.paymentsEnabled) return route.fulfill({ status: 503, json: { error: { code: 'INTERNAL', message: 'Payments are not configured', data: {} } } });
      state.checkout = req.postDataJSON() as Record<string, unknown>;
      // Stands in for Stripe: straight to the success return URL the server would build.
      const back = String(state.checkout.returnTo);
      return route.fulfill({ json: { url: `${url.origin}${back}${back.includes('?') ? '&' : '?'}checkout=success&session_id=cs_e2e`, sessionId: 'cs_e2e' } });
    }
    if (path === '/billing/checkout/cs_e2e') {
      state.paid = true;
      return route.fulfill({ json: { sessionId: 'cs_e2e', kind: 'plan', status: 'complete', planId: 'plus', interval: 'month', amountCents: null, credits: null, completedAt: Date.now(), seats: null, resume: null } });
    }
    return route.fallback();
  });
  return state;
}

test('1080p in the Advanced panel: checkout in a popup, the app keeps its URL, “You’re on Plus”, 1080p applied', async ({ page, context }) => {
  const state = await billing(page, context, { paymentsEnabled: true });
  await page.goto('/create/quick');
  const url = page.url();
  const locked = page.locator('main aside [data-group="res"] button[data-locked]');
  await expect(locked).toContainText('1080p');
  await locked.click();
  const dlg = page.getByRole('dialog', { name: '1080p needs Plus' });
  await expect(dlg.getByRole('radio', { name: /^Plus/ })).toHaveAttribute('aria-checked', 'true');
  const popup = page.waitForEvent('popup');
  await dlg.getByRole('button', { name: 'Continue with Plus' }).click();
  const w = await popup;
  // The popup's return page closes itself after telling the opener.
  await w.waitForEvent('close', { timeout: 15_000 });
  expect(state.checkout).toMatchObject({ kind: 'plan', planId: 'plus', interval: 'month' });
  expect(String(state.checkout!.returnTo)).toContain('rl_popup=1');
  await expect(page.getByRole('dialog', { name: 'You’re on Plus' })).toBeVisible();
  await expect(page.locator('main aside [data-group="res"] [aria-pressed="true"]')).toHaveText('1080p', { timeout: 6000 });
  await expect(page).toHaveURL(url);
});

test('payments not configured: the reason headline stays, “Payments aren’t available yet” under it, nothing breaks', async ({ page, context }) => {
  await billing(page, context, { paymentsEnabled: false });
  await page.goto('/create/quick');
  await page.locator('main aside [data-group="res"] button[data-locked]').click();
  const dlg = page.getByRole('dialog', { name: '1080p needs Plus' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('upgrade-unavailable')).toContainText('Payments aren’t available yet');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page).toHaveURL(/\/create\/quick$/);
});

test('a checkout that answers 503 (no Stripe keys) also lands on the unavailable state', async ({ page, context }) => {
  await billing(page, context, { paymentsEnabled: false });
  // The plans read is slow: the click comes first and the 503 decides.
  await page.route('**/api/billing/plans', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ json: { plans: [], paymentsEnabled: true } }).catch(() => undefined);
  });
  await page.goto('/create/quick');
  await page.locator('main aside [data-group="res"] button[data-locked]').click();
  await page.getByRole('dialog', { name: '1080p needs Plus' }).getByRole('button', { name: 'Continue with Plus' }).click();
  const dlg = page.getByRole('dialog', { name: '1080p needs Plus' });
  await expect(dlg.getByTestId('upgrade-modal')).toHaveAttribute('data-phase', 'unavailable');
  await expect(dlg.getByTestId('upgrade-unavailable')).toContainText('Payments aren’t available yet');
});
