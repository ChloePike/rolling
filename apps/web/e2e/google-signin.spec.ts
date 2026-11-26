import { expect, test, type Page } from '@playwright/test';
import { openApp } from './support/fidelity';

/**
 * D-017: Google sign-in in place. Our own design button opens Google's popup through
 * the GIS OAuth2 token client; One Tap is Google's own prompt; the full-page redirect
 * is the fallback. The GIS script is stubbed by route interception; the app loads it
 * only behind the mock seam `googleSdk`.
 */

const GIS = 'https://accounts.google.com/gsi/client';

/**
 * A tiny GIS: records `id.initialize` / `prompt` and `oauth2.initTokenClient` calls;
 * `requestAccessToken()` plays `window.__gis.popup`: `success` (callback with
 * `__gis.token`), `popup_closed`, `popup_failed_to_open`, `denied` or `hang`.
 */
const STUB = `
(() => {
  const s = (window.__gis = window.__gis || { inits: [], prompts: 0, popup: 'success' });
  s.tokenClients = []; s.requests = 0;
  window.google = { accounts: {
    id: {
      initialize(cfg) { s.inits.push(cfg); s.cfg = cfg; },
      renderButton() { s.rendered = (s.rendered || 0) + 1; },
      prompt() { s.prompts++; },
      cancel() {},
    },
    oauth2: {
      initTokenClient(cfg) {
        s.tokenClients.push({ client_id: cfg.client_id, scope: cfg.scope, prompt: cfg.prompt });
        return {
          requestAccessToken() {
            s.requests++;
            // Synchronous in the click, like the real client opening its popup.
            s.userActivation = navigator.userActivation ? navigator.userActivation.isActive : null;
            setTimeout(() => {
              if (s.popup === 'success') cfg.callback({ access_token: s.token || 'ya29.stub-access-token', token_type: 'Bearer', expires_in: 3599, scope: cfg.scope });
              else if (s.popup === 'denied') cfg.callback({ error: 'access_denied' });
              else if (s.popup !== 'hang') cfg.error_callback({ type: s.popup, message: s.popup });
            }, 30);
          },
        };
      },
    },
  } };
})();
`;

async function withGis(page: Page, opts: { signedOut?: boolean; block?: boolean; popup?: string; token?: string } = {}) {
  await page.addInitScript(
    ({ signedOut, popup, token }) => {
      const w = window as unknown as { __rollingMocks: Record<string, unknown>; __gis: Record<string, unknown>; __rollingRedirect: (u: string) => void; __redirectedTo?: string };
      w.__rollingMocks = { delayMs: 50, googleSdk: true, ...(signedOut ? { me: { signedOut: true } } : {}) };
      w.__gis = { inits: [], prompts: 0, popup, token };
      w.__rollingRedirect = (u) => {
        w.__redirectedTo = u;
      };
    },
    { signedOut: !!opts.signedOut, popup: opts.popup ?? 'success', token: opts.token },
  );
  let requested = 0;
  await page.route(GIS, (route) => {
    requested++;
    return opts.block ? route.abort('blockedbyclient') : route.fulfill({ contentType: 'text/javascript', body: STUB });
  });
  return { requested: () => requested };
}

interface GisState {
  inits: Record<string, unknown>[];
  prompts: number;
  rendered?: number;
  requests: number;
  userActivation: boolean | null;
  tokenClients: Record<string, unknown>[];
}
const gis = (page: Page) => page.evaluate(() => (window as unknown as { __gis: GisState }).__gis);
const redirectedTo = (page: Page) => page.evaluate(() => (window as unknown as { __redirectedTo?: string }).__redirectedTo ?? null);

/** Our button, once the token client is prepared. */
async function readyButton(page: Page) {
  const button = page.getByTestId('google-button');
  await expect(button).toHaveAttribute('data-gis', 'ready');
  await expect(button).toHaveText('Continue with Google');
  return button;
}

test.describe('Google sign-in without leaving the page (D-017)', () => {
  test('popup: our button opens the token client, signs in and honours ?redirect=', async ({ page }) => {
    await withGis(page, { signedOut: true });
    await openApp(page, '/login?redirect=%2Ftemplates');
    const button = await readyButton(page);
    // No official rendered button anywhere: only ours.
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(1);
    await expect(page.locator('iframe')).toHaveCount(0);
    const state = await gis(page);
    expect(state.rendered ?? 0).toBe(0);
    expect(state.tokenClients).toEqual([{ client_id: 'mock-client.apps.googleusercontent.com', scope: 'openid email profile', prompt: 'select_account' }]);
    await button.click();
    await expect(page).toHaveURL(/\/templates$/);
    await expect(page.getByText('You’re logged in.')).toBeVisible();
    const after = await gis(page);
    expect(after.requests).toBe(1);
    // Called inside the click's user activation (popup not blocked).
    expect(after.userActivation).toBe(true);
  });

  test('a refused token shows an inline message and re-enables the button', async ({ page }) => {
    await withGis(page, { signedOut: true, token: 'mock-invalid' });
    await openApp(page, '/signup');
    await (await readyButton(page)).click();
    await expect(page.getByTestId('auth-error')).toHaveText('That sign-in didn’t finish. Try again or continue with email.');
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByTestId('google-button')).toBeEnabled();
  });

  test('popup closed by the user: quiet, the button is usable again', async ({ page }) => {
    await withGis(page, { signedOut: true, popup: 'popup_closed' });
    await openApp(page, '/login');
    const button = await readyButton(page);
    await button.click();
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Continue with Google');
    await expect(page.getByTestId('auth-error')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await redirectedTo(page)).toBeNull();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('canceled consent says so inline', async ({ page }) => {
    await withGis(page, { signedOut: true, popup: 'denied' });
    await openApp(page, '/login');
    await (await readyButton(page)).click();
    await expect(page.getByTestId('auth-error')).toHaveText('Sign-in was canceled. Try again or continue with email.');
  });

  test('popup blocked (popup_failed_to_open): falls back to the full-page redirect', async ({ page }) => {
    await withGis(page, { signedOut: true, popup: 'popup_failed_to_open' });
    await openApp(page, '/login?redirect=%2Ftemplates');
    await (await readyButton(page)).click();
    await expect(page.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
    await expect.poll(() => redirectedTo(page)).toBe('/api/auth/google/start?redirect=%2Ftemplates');
  });

  test('script blocked: the same button falls back to the full-page redirect', async ({ page }) => {
    const sdk = await withGis(page, { signedOut: true, block: true });
    await openApp(page, '/login?redirect=%2Ftemplates');
    const button = page.getByTestId('google-button');
    await expect.poll(() => sdk.requested()).toBeGreaterThan(0);
    await expect(button).toHaveAttribute('data-gis', 'unavailable');
    await button.click();
    await expect(page.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
    await expect.poll(() => redirectedTo(page)).toBe('/api/auth/google/start?redirect=%2Ftemplates');
  });

  test('One Tap for signed-out visitors (ID token with a nonce)', async ({ page }) => {
    await withGis(page, { signedOut: true });
    await openApp(page, '/login');
    await readyButton(page);
    await expect.poll(async () => (await gis(page)).prompts).toBe(1);
    const cfg = (await gis(page)).inits.at(-1)!;
    expect(cfg).toMatchObject({ client_id: 'mock-client.apps.googleusercontent.com', ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, context: 'signin' });
    expect(String(cfg.nonce).length).toBeGreaterThan(16);
    // Google's One Tap credential signs in like before.
    await page.evaluate(() => (window as unknown as { __gis: { cfg: { callback: (r: unknown) => void } } }).__gis.cfg.callback({ credential: 'stub-id-token', select_by: 'auto' }));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('You’re logged in.')).toBeVisible();
  });

  test('One Tap is not shown to a signed-in user', async ({ page }) => {
    await withGis(page);
    await openApp(page, '/login');
    await readyButton(page);
    await page.waitForTimeout(300);
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
