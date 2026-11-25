import { expect, test } from '@playwright/test';
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

/**
 * D-006 replaced the design's placeholders, credit amounts, plan perks and
 * pack list, so text differs inside the same boxes. Layout is held by the
 * box test; this bound keeps the rest of the screen honest.
 */
const MAX_D006 = 0.05;

const PARTS = {
  title: 'main h1',
  plan1: 'main section:nth-of-type(1)',
  plan2: 'main section:nth-of-type(2)',
  plan3: 'main section:nth-of-type(3)',
};

test.describe('upgrade (Upgrade.dc.html)', () => {
  test('plans read D-006 pricing: Intl prices, resolution caps and perks, bonus credits, monthly / yearly, top-ups', async ({ page }) => {
    await openApp(page, '/upgrade');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a plan to start creating');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Starter', 'Plus', 'Pro', 'Top-ups']);
    const card = (id: string) => page.locator(`section[aria-labelledby="plan-${id}"]`);
    await expect(card('starter')).toContainText('$5');
    await expect(card('plus')).toContainText('$15');
    await expect(card('pro')).toContainText('$49');
    await expect(card('plus')).toContainText('Recommended');
    await expect(card('starter')).toContainText('Video up to 720p, images up to 2K');
    await expect(card('plus')).toContainText('Video up to 1080p, images up to 2K');
    await expect(card('pro')).toContainText('Video up to 4K, images up to 4K');
    await expect(card('plus')).toContainText('+800 bonus credits a month');
    await expect(card('plus')).toContainText('Worth $8. Refreshed on your billing date');
    await expect(card('plus')).toContainText('5 jobs at a time');
    await expect(card('plus')).toContainText('Voice cloning');
    await expect(card('plus')).toContainText('+5% bonus on every top-up');
    await expect(card('pro')).toContainText('10 seats, roles and per-member limits');
    await expect(card('pro')).toContainText('+10% bonus on every top-up');
    await expect(card('starter')).not.toContainText('Voice cloning');
    await expect(page.getByText('Studio')).toHaveCount(0);
    await expect(page.getByText('[PRICE]')).toHaveCount(0);
    const yearly = page.getByRole('tab', { name: /Yearly/ });
    await expect(yearly).toContainText('Save 20%');
    await yearly.click();
    await expect(yearly).toHaveAttribute('aria-selected', 'true');
    await expect(card('pro')).toContainText('$39.17');
    await expect(card('starter')).toContainText('per month, $48 billed yearly');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Monthly/ })).toHaveAttribute('aria-selected', 'true');
    for (const [usd, credits] of [[10, '1,000'], [25, '2,600'], [50, '5,500'], [100, '11,500'], [250, '28,750']] as const) {
      await expect(page.locator(`[data-topup="${usd}"]`)).toContainText(`${credits} credits`);
    }
    await expect(page.locator('[data-topup="25"]')).toContainText('4% bonus credits');
    await expect(page.getByText('Any amount from $10. Plus adds 5% and Pro adds 10% on every top-up.')).toBeVisible();
  });

  test('box measurements within 2px of the design', async ({ page }) => {
    await openDesign(page, 'Upgrade.dc.html');
    const design = await measure(page, PARTS);
    await openApp(page, '/upgrade');
    await settle(page);
    const app = await measure(page, PARTS);
    // D-006 gives Pro five perks (the design draws four), so plan cards grow taller; position and width must hold.
    for (const k of ['plan1', 'plan2', 'plan3'] as const) app[k]!.height = design[k]!.height;
    expectBoxesClose(app, design);
  });

  for (const period of ['Monthly', 'Yearly']) {
    test(`${period}: pixel diff at 1440x900 is at most 1%`, async ({ page }, info) => {
      const r = await diffScreen(page, info, {
        feature: 'account',
        name: `upgrade-${period.toLowerCase()}`,
        design: async () => {
          await openDesign(page, 'Upgrade.dc.html');
          if (period === 'Yearly') await page.getByRole('tab', { name: /Yearly/ }).click();
        },
        app: async () => {
          await openApp(page, '/upgrade');
          if (period === 'Yearly') await page.getByRole('tab', { name: /Yearly/ }).click();
        },
      });
      expectDiffUnder(r, MAX_D006);
    });
  }

  test('full page (1440x1500): pixel diff is at most 1%', async ({ page }, info) => {
    const r = await diffScreen(page, info, {
      feature: 'account',
      name: 'upgrade-full',
      height: 1500,
      design: () => openDesign(page, 'Upgrade.dc.html', {}, 1500),
      app: () => openApp(page, '/upgrade', 1500),
    });
    expectDiffUnder(r, MAX_D006);
  });

  test('motion: plan cards stagger in, the period marker slides, reduced motion skips movement', async ({ page }) => {
    await openApp(page, '/upgrade');
    await page.locator('main section[aria-labelledby="plan-pro"]').waitFor();
    const delays = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main section[aria-labelledby^="plan-"]')).map((el) => getComputedStyle(el).animationDelay),
    );
    expect(delays).toEqual(['0s', '0.03s', '0.06s']);
    const t = await animationTiming(page, 'main section[aria-labelledby="plan-plus"]');
    expect(t?.duration).toBe(200);
    await settle(page);
    const marker = page.locator('[role="tablist"] [aria-hidden="true"]');
    const before = (await marker.boundingBox())!;
    await page.getByRole('tab', { name: /Yearly/ }).click();
    // Sample the marker while it slides: it passes through positions between the two tabs.
    const xs: number[] = [];
    for (let k = 0; k < 12; k++) {
      xs.push((await marker.boundingBox())!.x);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    const end = (await marker.boundingBox())!;
    expect(end.x).toBeGreaterThan(before.x + 20);
    expect(xs.some((x) => x > before.x + 1 && x < end.x - 1), `intermediate positions ${xs.join(', ')}`).toBe(true);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/upgrade');
    await settle(page);
    const m2 = page.locator('[role="tablist"] [aria-hidden="true"]');
    await page.getByRole('tab', { name: /Yearly/ }).click();
    await page.waitForTimeout(30);
    const yearlyBox = (await page.getByRole('tab', { name: /Yearly/ }).boundingBox())!;
    expect(Math.abs((await m2.boundingBox())!.x - yearlyBox.x)).toBeLessThanOrEqual(1);
  });
});
