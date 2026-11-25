import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { animationTiming, openApp, settle } from './support/fidelity';
import { asPlan } from './support/session';

/**
 * /upgrade intentionally departs from Upgrade.dc.html (owner: “too plain”), so
 * this spec checks layout by measurement and behavior instead of a pixel diff,
 * and saves full-page screenshots in both themes for review.
 */
const SCREENS = fileURLToPath(new URL('./__screens__/account/', import.meta.url));
const STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
const EXIT = 'cubic-bezier(0.4, 0, 1, 1)';

/** D-006 example prices: Seedance 2.5 720p 5s = 347 credits; Seedream 5.0 Lite = 9 credits per image. */
async function routeCatalog(page: Page) {
  const models = [
    {
      id: 'bytedance/seedance-2.5', kind: 'video', name: 'Seedance 2.5', tags: [], default: true, placement: 'featured', auto: true, mature: false, matureOnly: false,
      requiresIdentitySafety: false, operations: [], seconds: { min: 5, max: 30 }, defaultSeconds: 5, resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p',
      ratios: ['9:16'], audio: true, lipSync: false, credits: [{ resolution: '720p', seconds: 5, credits: 347 }, { resolution: '1080p', seconds: 5, credits: 780 }],
    },
    {
      id: 'minimax/minimax-h3', kind: 'video', name: 'MiniMax H3', tags: [], default: false, placement: 'featured', auto: true, mature: false, matureOnly: false,
      requiresIdentitySafety: false, operations: [], seconds: { min: 5, max: 15 }, defaultSeconds: 5, resolutions: ['768p'], defaultResolution: '768p',
      ratios: ['9:16'], audio: true, lipSync: true, credits: [{ resolution: '768p', seconds: 5, credits: 300 }],
    },
    {
      id: 'bytedance/seedream-5.0-lite', kind: 'image', name: 'Seedream 5.0 Lite', tags: [], default: true, placement: 'featured', auto: true, mature: false, matureOnly: false,
      requiresIdentitySafety: false, operations: [], seconds: null, defaultSeconds: null, resolutions: ['2K'], defaultResolution: '2K',
      ratios: ['1:1'], audio: false, lipSync: false, credits: [{ resolution: '2K', seconds: null, credits: 9 }],
    },
  ];
  await page.route('**/api/models**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { models: kind ? models.filter((m) => m.kind === kind) : models } });
  });
}

const card = (page: Page, id: string) => page.locator(`section[aria-labelledby="plan-${id}"]`);

test.describe('upgrade /upgrade', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rollingMocks?: Record<string, unknown> }).__rollingMocks = {
        ...(window as unknown as { __rollingMocks?: Record<string, unknown> }).__rollingMocks,
        delayMs: 250,
      };
    });
    await routeCatalog(page);
  });

  test('plan cards: D-006 prices, Plus recommended, included credits as shots and images, resolution caps', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, '/upgrade');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pick a plan to start creating');
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Starter');
    await expect(card(page, 'starter')).toContainText('$5');
    await expect(card(page, 'plus')).toContainText('$15');
    await expect(card(page, 'pro')).toContainText('$49');
    await expect(card(page, 'plus')).toContainText('Recommended');
    await expect(card(page, 'starter')).not.toContainText('Recommended');
    await expect(page.getByTestId('eq-plus')).toHaveText('≈ 2 Seedance 2.5 shots of 5s at 720p or ≈ 88 images with Seedream 5.0 Lite');
    await expect(page.getByTestId('eq-pro')).toHaveText('≈ 7 Seedance 2.5 shots of 5s at 720p or ≈ 277 images with Seedream 5.0 Lite');
    // 200 credits buy less than one 347-credit shot and the catalog has no 480p price: images, never "0 shots" or seconds.
    await expect(page.getByTestId('eq-starter')).toHaveText('≈ 22 images with Seedream 5.0 Lite');
    await expect(card(page, 'plus')).toContainText('800 credits');
    await expect(card(page, 'plus')).toContainText('Worth $8');
    const caps = async (id: string, kind: 'Video' | 'Images') =>
      card(page, id).getByRole('list', { name: new RegExp(`^${kind} up to`) }).locator('li').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-cap')}:${e.getAttribute('data-included')}`));
    expect(await caps('starter', 'Video')).toEqual(['720p:true', '1080p:false', '4K:false']);
    expect(await caps('plus', 'Video')).toEqual(['720p:true', '1080p:true', '4K:false']);
    expect(await caps('pro', 'Video')).toEqual(['720p:true', '1080p:true', '4K:true']);
    expect(await caps('plus', 'Images')).toEqual(['2K:true', '4K:false']);
    await expect(card(page, 'starter').locator('[data-cap="1080p"]')).toHaveAttribute('title', '1080p needs Plus');
    await expect(card(page, 'plus').locator('[data-cap="4K"]').first()).toHaveAttribute('title', '4K needs Pro');
    await expect(card(page, 'plus')).toContainText('Voice cloning');
    await expect(card(page, 'starter')).not.toContainText('Voice cloning');
    // D-013: personal plans have one seat; seats are on Team.
    await expect(card(page, 'pro')).not.toContainText('seats');
    await expect(card(page, 'pro')).toContainText('+10% bonus on every top-up');
    await expect(page.getByText('[PRICE]')).toHaveCount(0);
  });

  test('monthly / yearly: prices swap with exit and enter motion, yearly shows the total and the saving', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, '/upgrade');
    await settle(page);
    const yearly = page.getByRole('tab', { name: /Yearly/ });
    await expect(yearly).toContainText('Save 20%');
    await yearly.click();
    const leave = page.locator('[data-plan="pro"] [data-swap] > [aria-hidden="true"]').first();
    await expect(leave).toBeAttached();
    const out = await leave.evaluate((el) => {
      const a = el.getAnimations()[0]!;
      return { duration: a.effect!.getComputedTiming().duration, easing: (a.effect as KeyframeEffect).getKeyframes()[0]!.easing };
    });
    expect(out).toEqual({ duration: 140, easing: EXIT });
    const enter = await animationTiming(page, '[data-plan="pro"] [data-swap="$39.17"] > :not([aria-hidden])');
    expect(enter).toMatchObject({ duration: 200, easing: STANDARD, firstTransform: 'translateY(4px)' });
    await expect(page.getByTestId('price-pro')).toHaveText('$39.17');
    await expect(page.getByTestId('price-starter')).toHaveText('$4');
    await expect(card(page, 'pro')).toContainText('$470 billed yearly');
    await expect(card(page, 'pro')).toContainText('Save $118 a year');
    await expect(page.locator('[data-row="price"] [data-col="plus"]')).toHaveText('$12 a month');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: /Monthly/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('price-pro')).toHaveText('$49');
    await expect(card(page, 'pro')).toContainText('Billed monthly');
  });

  test('a non-member picks Plus: checkout pending, toast, card turns into the current plan', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, '/upgrade');
    const cta = card(page, 'plus').getByRole('button', { name: 'Start with Plus' });
    await cta.click();
    await expect(card(page, 'plus').getByRole('button', { name: 'Opening checkout…' })).toBeDisabled();
    await expect(page.getByText('You’re on Plus. Generating and top-ups are unlocked.')).toBeVisible();
    await expect(card(page, 'plus')).toContainText('Current plan');
    await expect(card(page, 'plus').getByRole('button', { name: 'Your current plan' })).toBeDisabled();
    await expect(card(page, 'pro').getByRole('button', { name: 'Switch to Pro' })).toBeEnabled();
    // Top-ups open up for the new member at the Plus bonus.
    await expect(page.getByTestId('topup-buy')).toHaveText('Buy 5,750 credits for $50');
  });

  test('a member switches plans from a card', async ({ page }) => {
    await asPlan(page, 'starter');
    await openApp(page, '/upgrade');
    await expect(card(page, 'starter').getByRole('button', { name: 'Your current plan' })).toBeDisabled();
    await card(page, 'pro').getByRole('button', { name: 'Switch to Pro' }).click();
    await expect(page.getByText('Switched to Pro.')).toBeVisible();
    await expect(card(page, 'pro')).toContainText('Current plan');
  });

  test('top-up calculator: any amount, tier and plan bonus live, ladder, presets, slider, validation, purchase', async ({ page }) => {
    await asPlan(page, 'pro');
    await openApp(page, '/upgrade');
    const calc = page.getByTestId('topup-calculator');
    const amount = calc.getByLabel('Amount', { exact: true });
    await expect(amount).toHaveValue('50');
    await expect(page.getByTestId('topup-base')).toHaveText('5,000');
    await expect(page.getByTestId('topup-tier')).toHaveText('+500');
    await expect(page.getByTestId('topup-plan')).toHaveText('+500');
    await expect(page.getByTestId('topup-total')).toHaveText('6,000');
    await expect(calc.locator('[aria-current="step"]')).toHaveAttribute('data-tier', '50');
    await expect(page.getByTestId('next-tier')).toHaveText('Add $50 to get +15%');

    await amount.fill('40');
    await expect(page.getByTestId('topup-tier')).toHaveText('+160');
    await expect(page.getByTestId('topup-total')).toHaveText('4,560');
    await expect(calc.locator('[aria-current="step"]')).toHaveAttribute('data-tier', '25');
    await expect(page.getByTestId('next-tier')).toHaveText('Add $10 to get +10%');
    await expect(calc.locator('[data-tier="10"]')).toHaveClass(/rungReached/);

    await calc.getByRole('button', { name: '$100', exact: true }).click();
    await expect(amount).toHaveValue('100');
    await expect(calc.getByRole('button', { name: '$100', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('topup-total')).toHaveText('12,500');
    await expect(page.getByTestId('next-tier')).toHaveText('Highest amount bonus');

    const slider = calc.getByRole('slider', { name: 'Top-up amount' });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(amount).toHaveValue('1000');
    await page.keyboard.press('Home');
    await expect(amount).toHaveValue('10');
    await expect(page.getByTestId('topup-total')).toHaveText('1,100');

    await amount.fill('5');
    await expect(calc.getByRole('alert')).toHaveText('The minimum top-up is $10.');
    await expect(page.getByTestId('topup-buy')).toBeDisabled();
    await amount.fill('12000');
    await expect(calc.getByRole('alert')).toHaveText('The maximum top-up is $10,000.');
    await amount.fill('25');

    // Previewing another plan's bonus turns the button into a plan switch.
    await calc.getByRole('radio', { name: /Plus/ }).click();
    await expect(page.getByTestId('topup-plan')).toHaveText('+125');
    await expect(page.getByTestId('topup-buy')).toHaveText('Switch to Plus for this bonus');
    await calc.getByRole('radio', { name: /Pro/ }).click();
    await expect(page.getByTestId('topup-buy')).toHaveText('Buy 2,850 credits for $25');
    await page.getByTestId('topup-buy').click();
    await expect(page.getByTestId('topup-buy')).toHaveText('Buying…');
    await expect(page.getByText('2,850 credits added. They never expire.')).toBeVisible();
  });

  test('a non-member’s top-up button leads to the plans', async ({ page }) => {
    await asPlan(page, null);
    await openApp(page, '/upgrade');
    await page.getByTestId('topup-calculator').scrollIntoViewIfNeeded();
    await expect(page.getByText('Top-ups are for members. Any plan works.')).toBeVisible();
    await page.getByTestId('topup-buy').click();
    await expect(card(page, 'plus').getByRole('button', { name: 'Start with Plus' })).toBeFocused();
    await expect(card(page, 'plus')).toBeInViewport();
  });

  test('comparison table, model row and FAQ accordion', async ({ page }) => {
    await openApp(page, '/upgrade');
    const row = (id: string) => page.locator(`[data-row="${id}"] td`);
    await expect(row('jobs')).toHaveText(['2', '5', '10', '10 + 2 per extra seat, up to 30']);
    await expect(row('video')).toHaveText(['720p', '1080p', '4K', '4K']);
    await expect(row('image')).toHaveText(['2K', '2K', '4K', '4K']);
    await expect(row('seats')).toHaveText(['Just you', 'Just you', 'Just you', 'Any number, $25 each']);
    await expect(row('credits')).toHaveText(['200', '800', '2,500', '2,500 + 500 per extra seat']);
    await expect(row('price')).toHaveText(['$5 a month', '$15 a month', '$49 a month', '$79 a month + $25 per extra seat']);
    await expect(row('shots')).toHaveText(['22 images', '2', '7', '7 + 1 per extra seat']);
    await expect(row('voice')).toHaveText(['Not included', 'Included', 'Included', 'Included']);
    await expect(row('topUpBonus')).toHaveText(['Not included', '+5%', '+10%', '+10%']);
    await expect(row('agent')).toHaveText(['Included', 'Included', 'Included', 'Included']);
    const recBg = await page.locator('[data-row="jobs"] [data-col="plus"]').evaluate((e) => getComputedStyle(e).backgroundColor);
    const otherBg = await page.locator('[data-row="jobs"] [data-col="pro"]').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(recBg).not.toBe(otherBg);

    // Not "same models on every plan": MiniMax H3 starts at 768p, above Starter's 720p cap (D-006).
    await expect(page.getByRole('heading', { name: 'Models by plan' })).toBeVisible();
    await expect(page.locator('[data-model]')).toHaveText([/Seedance 2\.5All plans$/, /MiniMax H3Plus and up$/, /Seedream 5\.0 LiteAll plans$/]);
    await expect(page.locator('[data-model="minimax/minimax-h3"]')).toHaveAttribute('data-min-plan', 'plus');

    const q = page.getByRole('button', { name: 'Do credits expire?' });
    const panel = page.getByRole('region', { name: 'Do credits expire?' });
    await expect(q).toHaveAttribute('aria-expanded', 'false');
    expect((await panel.boundingBox())!.height).toBeLessThan(1);
    await q.click();
    await expect(q).toHaveAttribute('aria-expanded', 'true');
    const tr = await panel.evaluate((e) => ({ d: getComputedStyle(e).transitionDuration, f: getComputedStyle(e).transitionTimingFunction }));
    expect(tr.d.split(', ')[0]).toBe('0.2s');
    expect(tr.f.startsWith(STANDARD)).toBe(true);
    await expect(panel).toContainText('Purchased credits never expire.');
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(20);
    await page.keyboard.press('Enter');
    await expect(q).toHaveAttribute('aria-expanded', 'false');
    const closing = await panel.evaluate((e) => getComputedStyle(e).transitionDuration);
    expect(closing.split(', ')[0]).toBe('0.14s');
    for (const name of ['How does billing work?', 'What happens when a run fails?', 'Can I cancel anytime?']) {
      await page.getByRole('button', { name }).click();
      await expect(page.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }
  });

  test('layout at 1440: centered hero, three equal plan cards in one row, two-column calculator, no horizontal scroll', async ({ page }) => {
    await openApp(page, '/upgrade');
    await settle(page);
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const h1 = await box('main h1');
    expect(Math.abs(h1.x + h1.width / 2 - 720)).toBeLessThanOrEqual(2);
    const cards = await Promise.all(['starter', 'plus', 'pro'].map((id) => box(`[data-plan="${id}"]`)));
    expect(new Set(cards.map((c) => Math.round(c.y))).size).toBe(1);
    expect(Math.max(...cards.map((c) => c.width)) - Math.min(...cards.map((c) => c.width))).toBeLessThanOrEqual(1);
    expect(cards[0]!.width).toBeGreaterThan(330);
    expect(cards[1]!.x - (cards[0]!.x + cards[0]!.width)).toBeCloseTo(14, 0);
    const ring = await page.locator('[data-plan="plus"]').evaluate((e) => getComputedStyle(e).boxShadow);
    expect(ring).toContain('inset');
    const inputs = await box('[data-testid="topup-calculator"] input[inputmode="decimal"]');
    const result = await box('[data-testid="topup-total"]');
    expect(result.x).toBeGreaterThan(inputs.x + inputs.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1024, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('motion: plan cards stagger 30ms, period marker slides, reduced motion fades only', async ({ page }) => {
    await openApp(page, '/upgrade');
    await page.locator('[data-plan="pro"]').waitFor();
    const delays = await page.$$eval('[data-plan]', (els) => els.map((el) => getComputedStyle(el).animationDelay));
    expect(delays).toEqual(['0s', '0.03s', '0.06s', '0.09s']);
    expect(await animationTiming(page, '[data-plan="plus"]')).toMatchObject({ duration: 200, easing: STANDARD });
    await settle(page);
    const marker = page.locator('[role="tablist"] [aria-hidden="true"]');
    const before = (await marker.boundingBox())!;
    await page.getByRole('tab', { name: /Yearly/ }).click();
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
    await page.getByRole('tab', { name: /Yearly/ }).click();
    const t = await animationTiming(page, '[data-plan="pro"] [data-swap="$39.17"] > :not([aria-hidden])');
    if (t) expect(t.firstTransform).toMatch(/^(none|translateY\(0px\))$/);
    await expect(page.getByTestId('price-pro')).toHaveText('$39.17');
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`screenshots (${theme}): full page, monthly and yearly`, async ({ page }) => {
      mkdirSync(SCREENS, { recursive: true });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((t) => {
        try {
          const raw = localStorage.getItem('rolling.prefs');
          localStorage.setItem('rolling.prefs', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), theme: t }));
        } catch {
          /* ignore */
        }
      }, theme);
      await asPlan(page, null);
      await openApp(page, '/upgrade');
      await page.getByRole('button', { name: 'Do credits expire?' }).click();
      await settle(page);
      await page.screenshot({ path: `${SCREENS}upgrade-${theme}-monthly.png`, fullPage: true });
      await page.getByRole('tab', { name: /Yearly/ }).click();
      await settle(page);
      await page.screenshot({ path: `${SCREENS}upgrade-${theme}-yearly-top.png` });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).not.toBe('');
    });
  }
});
