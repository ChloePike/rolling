import { expect, test, type Page } from '@playwright/test';
import {
  animationTiming,
  diffScreen,
  expectBoxesClose,
  expectDiffUnder,
  measure,
  openApp,
  openDesign,
  settle,
} from './support/fidelity';

const DESIGN_PARTS = {
  form: 'main > div:nth-child(2) > div',
  title: 'h1',
  google: 'main button:nth-of-type(1)',
  email: 'input',
  aside: 'aside',
};
const APP_PARTS = {
  form: 'form',
  title: 'h1',
  google: 'form > button:nth-of-type(1)',
  email: 'input[type="email"]',
  aside: 'aside',
};

async function toCodeStep(page: Page) {
  await page.getByLabel('Email').fill('alex@ridgeline.co');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test.describe('auth screens (Login.dc.html)', () => {
  test('log in: copy, links and layout', async ({ page }) => {
    await openApp(page, '/login');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
    await expect(page.getByText('Log in to pick up where you left off.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeVisible();
    await expect(page.getByTestId('app-header')).toHaveCount(0);
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your account');
    await page.getByRole('link', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('email validation and code step with countdown and back', async ({ page }) => {
    await page.clock.install();
    await openApp(page, '/login');
    await page.getByRole('button', { name: 'Continue with email' }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter a valid email address.');
    await toCodeStep(page);
    await expect(page.getByText('We sent a 6-digit code to alex@ridgeline.co. It expires in 10 minutes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resend in 1:00' })).toBeDisabled();
    await page.clock.runFor(18_000);
    await expect(page.getByRole('button', { name: 'Resend in 0:42' })).toBeVisible();
    await page.keyboard.type('48a2');
    await expect(page.getByLabel('Verification code').locator('input')).toHaveValue('482');
    await page.getByRole('button', { name: '← Back' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  });

  test('verify with a full code goes Home', async ({ page }) => {
    await openApp(page, '/login');
    await toCodeStep(page);
    await page.keyboard.type('482913');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  for (const s of [
    { name: 'login', path: '/login', props: {} },
    { name: 'signup', path: '/signup', props: { initMode: 'Sign up' } },
  ]) {
    test(`${s.name}: box measurements within 2px of the design`, async ({ page }) => {
      await openDesign(page, 'Login.dc.html', s.props);
      const design = await measure(page, DESIGN_PARTS);
      await openApp(page, s.path);
      await settle(page);
      const app = await measure(page, APP_PARTS);
      expectBoxesClose(app, design);
    });

    test(`${s.name}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      const r = await diffScreen(page, info, {
        feature: 'auth',
        name: s.name,
        appHeader: false,
        design: () => openDesign(page, 'Login.dc.html', s.props),
        app: async () => {
          await openApp(page, s.path);
          await page.locator('body').click({ position: { x: 1000, y: 10 } });
        },
      });
      expectDiffUnder(r);
    });
  }

  test('code: pixel diff at 1440x900 is at most 1%', async ({ page }, info) => {
    const r = await diffScreen(page, info, {
      feature: 'auth',
      name: 'code',
      appHeader: false,
      design: () => openDesign(page, 'Login.dc.html', { initStep: 'code' }),
      app: async () => {
        await page.clock.install();
        await openApp(page, '/login');
        await toCodeStep(page);
        await page.clock.runFor(18_000);
        await page.keyboard.type('482');
        await page.clock.resume();
      },
    });
    expectDiffUnder(r);
  });

  test('motion: steps enter with 200ms standard fade and 4px rise; reduced motion is opacity only', async ({ page }) => {
    await openApp(page, '/login');
    await page.getByLabel('Email').fill('alex@ridgeline.co');
    await page.getByRole('button', { name: 'Continue with email' }).click();
    const t = await animationTiming(page, '[data-testid="auth-code"]');
    expect(t?.duration).toBe(200);
    expect(t?.easing).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(t?.firstTransform).toBe('translateY(4px)');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/login');
    await page.getByLabel('Email').fill('alex@ridgeline.co');
    await page.getByRole('button', { name: 'Continue with email' }).click();
    const r = await animationTiming(page, '[data-testid="auth-code"]');
    if (r) {
      expect(r.duration).toBeLessThanOrEqual(1);
      expect(r.firstTransform).toMatch(/translateY\(0px\)|none|^$/);
    }
  });
});
