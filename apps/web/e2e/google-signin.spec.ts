import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support/fidelity';

/**
 * D-016: Google sign-in in place (Google Identity Services popup and One Tap),
 * with the full-page redirect as the fallback. The GIS script is stubbed by
 * route interception; the app loads it only behind the mock seam `googleSdk`.
 */

const GIS = 'https://accounts.google.com/gsi/client';

/** A tiny GIS: records initialize/prompt calls, renders a button whose click plays `window.__gis.popup`. */
const STUB = `
(() => {
  const s = (window.__gis = window.__gis || { inits: [], prompts: 0, renders: 0, popup: 'success' });
  window.google = { accounts: { id: {
    initialize(cfg) { s.inits.push(cfg); s.cfg = cfg; },
    renderButton(el, opts) {
      s.renders++;
      s.buttonOptions = opts;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Sign in with Google (stub)';
      b.onclick = () => {
        opts.click_listener && opts.click_listener();
        if (s.popup === 'success') s.cfg.callback({ credential: s.credential || 'stub-id-token', select_by: 'btn' });
        else window.dispatchEvent(new Event('focus'));
      };
      el.replaceChildren(b);
    },
    prompt() { s.prompts++; },
    cancel() {},
  } } };
})();
`;

async function withGis(page: Page, opts: { signedOut?: boolean; block?: boolean } = {}) {
  await page.addInitScript((signedOut) => {
    const w = window as unknown as { __rollingMocks: Record<string, unknown> };
    w.__rollingMocks = { delayMs: 50, googleSdk: true, ...(signedOut ? { me: { signedOut: true } } : {}) };
  }, !!opts.signedOut);
  let requested = 0;
  await page.route(GIS, (route) => {
    requested++;
    return opts.block ? route.abort('blockedbyclient') : route.fulfill({ contentType: 'text/javascript', body: STUB });
  });
  return { requested: () => requested };
}

const gis = (page: Page) => page.evaluate(() => (window as unknown as { __gis: { inits: Record<string, unknown>[]; prompts: number; renders: number; buttonOptions: Record<string, unknown> } }).__gis);

test.describe('Google sign-in without leaving the page (D-016)', () => {
  test('popup: the official button signs in and honours ?redirect=', async ({ page }) => {
    await withGis(page, { signedOut: true });
    await openApp(page, '/login?redirect=%2Ftemplates');
    const button = page.getByTestId('google-button').getByRole('button', { name: 'Sign in with Google (stub)' });
    await expect(button).toBeVisible();
    // The design's own button is replaced by the official one.
    await expect(page.getByTestId('google-fallback')).toHaveCount(0);
    const state = await gis(page);
    const cfg = state.inits.at(-1)!;
    expect(cfg).toMatchObject({ client_id: 'mock-client.apps.googleusercontent.com', ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, context: 'signin' });
    expect(String(cfg.nonce).length).toBeGreaterThan(16);
    expect(state.buttonOptions).toMatchObject({ theme: 'outline', size: 'large', text: 'continue_with', width: 360 });
    await button.click();
    await expect(page).toHaveURL(/\/templates$/);
    await expect(page.getByText('You’re logged in.')).toBeVisible();
  });

  test('a refused token shows an inline message and starts over with a new nonce', async ({ page }) => {
    await withGis(page, { signedOut: true });
    await page.addInitScript(() => {
      (window as unknown as { __gis: Record<string, unknown> }).__gis = { inits: [], prompts: 0, renders: 0, popup: 'success', credential: 'mock-invalid' };
    });
    await openApp(page, '/signup');
    await page.getByRole('button', { name: 'Sign in with Google (stub)' }).click();
    await expect(page.getByTestId('auth-error')).toHaveText('That sign-in didn’t finish. Try again or continue with email.');
    await expect(page).toHaveURL(/\/signup$/);
    await expect.poll(async () => (await gis(page)).inits.length).toBe(2);
    const { inits } = await gis(page);
    expect(inits[1]!.nonce).not.toBe(inits[0]!.nonce);
  });

  test('a closed popup says so and the next try uses redirect mode', async ({ page }) => {
    await withGis(page, { signedOut: true });
    await page.addInitScript(() => {
      (window as unknown as { __gis: Record<string, unknown> }).__gis = { inits: [], prompts: 0, renders: 0, popup: 'closed' };
    });
    await openApp(page, '/login');
    await page.getByRole('button', { name: 'Sign in with Google (stub)' }).click();
    await expect(page.getByTestId('auth-error')).toHaveText('The Google window closed before you finished. Try again to continue in this window.');
    await expect.poll(async () => (await gis(page)).inits.at(-1)?.ux_mode).toBe('redirect');
    expect((await gis(page)).inits.at(-1)!.login_uri).toBe('/api/auth/google/credential');
  });

  test('script blocked: the design button falls back to the full-page redirect', async ({ page }) => {
    const sdk = await withGis(page, { signedOut: true, block: true });
    await page.addInitScript(() => {
      const w = window as unknown as { __rollingRedirect: (u: string) => void; __redirectedTo?: string };
      w.__rollingRedirect = (u) => {
        w.__redirectedTo = u;
      };
    });
    await openApp(page, '/login?redirect=%2Ftemplates');
    const fallback = page.getByRole('button', { name: 'Continue with Google' });
    await expect(fallback).toBeVisible();
    expect(sdk.requested()).toBeGreaterThan(0);
    await fallback.click();
    await expect(page.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __redirectedTo?: string }).__redirectedTo)).toBe('/api/auth/google/start?redirect=%2Ftemplates');
  });

  test('One Tap only for signed-out visitors', async ({ page }) => {
    // Signed out on /login: One Tap prompts.
    await withGis(page, { signedOut: true });
    await openApp(page, '/login');
    await expect(page.getByRole('button', { name: 'Sign in with Google (stub)' })).toBeVisible();
    await expect.poll(async () => (await gis(page)).prompts).toBe(1);
  });

  test('One Tap is not shown to a signed-in user', async ({ page }) => {
    await withGis(page);
    await openApp(page, '/login');
    await expect(page.getByRole('button', { name: 'Sign in with Google (stub)' })).toBeVisible();
    expect((await gis(page)).prompts).toBe(0);
  });

  test('Upgrade: One Tap for a signed-out visitor; nothing loads for members', async ({ page, context }) => {
    await withGis(page, { signedOut: true });
    await openApp(page, '/upgrade');
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __gis?: { prompts: number } }).__gis?.prompts)) ?? 0).toBe(1);

    const member = await context.newPage();
    const sdk = await withGis(member);
    await openApp(member, '/upgrade');
    await expect(member.getByRole('heading', { level: 1 })).toBeVisible();
    await member.waitForTimeout(500);
    expect(sdk.requested()).toBe(0);
  });
});
