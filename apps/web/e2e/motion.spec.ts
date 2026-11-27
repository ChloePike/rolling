import { expect, test, type Page } from '@playwright/test';
import { routeModels } from './support/models';
import { clearMotion, layoutShift, motionLog, recordMotion, reducedMotionViolations, TOKEN_MS, type MotionEntry } from './support/motion';
import { asPlan } from './support/session';

/**
 * Motion (docs/motion-audit.md, handoff 7). Mocks, 1440×900.
 * - Reduced motion: on every key surface nothing moves, nothing loops and no
 *   fade is longer than --dur-reduced (200ms).
 * - No preference: every animation and transition that runs uses a token
 *   duration and curve; exits are shorter than enters and use the exit curve.
 * - Home and Canvas load without layout shift.
 * The source-level guard (no literal durations/easings) is
 * src/styles/motion-tokens.test.ts.
 */

const W = 1440;
const H = 900;
const CURVES = ['cubic-bezier(0.2, 0, 0, 1)', 'cubic-bezier(0.4, 0, 1, 1)', 'cubic-bezier(0.3, 1.4, 0.4, 1)', 'cubic-bezier(0.4, 0, 0.6, 1)', 'linear', 'steps(1)'];

async function open(page: Page, path = '/') {
  await routeModels(page);
  await recordMotion(page);
  await page.setViewportSize({ width: W, height: H });
  await page.goto(path);
  if (path.startsWith('/p/')) await page.locator('.react-flow__node').first().waitFor();
  else await page.getByTestId('app-header').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Runs `act`, lets its motion finish, and returns what animated meanwhile. */
async function during(page: Page, act: () => Promise<unknown>, settleMs = 500): Promise<MotionEntry[]> {
  await page.waitForTimeout(300);
  await clearMotion(page);
  await act();
  await page.waitForTimeout(settleMs);
  return motionLog(page, true);
}

/** Every surface, as [name, setup, act]; each act opens (and where it can, closes) the surface. */
const SURFACES: Array<[string, (page: Page) => Promise<void>, (page: Page) => Promise<void>]> = [
  [
    'header credits popover',
    (p) => open(p),
    async (p) => {
      await p.getByRole('button', { name: /Credit balance/ }).click();
      await expect(p.locator('.rl-pop[data-state="open"]')).toBeVisible();
      await p.waitForTimeout(300);
      await p.keyboard.press('Escape');
    },
  ],
  [
    'prompt + menu and asset picker',
    (p) => open(p),
    async (p) => {
      await p.getByRole('button', { name: 'Add assets or skills' }).click();
      await p.getByRole('menuitem', { name: /character or asset/i }).click();
      await expect(p.getByRole('dialog').first()).toBeVisible();
      await p.waitForTimeout(400);
      await p.keyboard.press('Escape');
    },
  ],
  [
    'upgrade modal (non-member agent send)',
    async (p) => {
      await asPlan(p, null);
      await open(p);
    },
    async (p) => {
      await p.locator('textarea').fill('A 15 second ad for sparkling water');
      await p.keyboard.press('Enter');
      await expect(p.getByRole('dialog').first()).toBeVisible();
      await p.waitForTimeout(400);
      await p.keyboard.press('Escape');
    },
  ],
  [
    'agent conversation (message, typing, plan card)',
    (p) => open(p),
    async (p) => {
      await p.locator('textarea').fill('A 15 second ad for a sparkling water brand');
      await p.keyboard.press('Enter');
      await expect(p.getByRole('button', { name: 'Build on canvas' })).toBeVisible({ timeout: 15_000 });
    },
  ],
  [
    'home run card and failure toast',
    async (p) => {
      await p.addInitScript(() => {
        const w = window as unknown as { __rollingMocks?: Record<string, unknown> };
        w.__rollingMocks = { ...w.__rollingMocks, latencyMs: 300, run: 'fail' };
      });
      await open(p);
    },
    async (p) => {
      await p.getByRole('tablist', { name: 'Creation mode' }).getByRole('tab', { name: 'Image' }).click();
      await p.locator('textarea').fill('Bottle');
      await p.getByRole('button', { name: 'Start' }).click();
      await expect(p.locator('[data-testid="home-run"][data-status="failed"]')).toBeVisible({ timeout: 15_000 });
      await expect(p.locator('.rl-toast').first()).toBeVisible();
    },
  ],
  [
    'template preview',
    (p) => open(p, '/templates'),
    async (p) => {
      await p.getByRole('region', { name: 'Featured' }).locator('[data-template]').first().click();
      await expect(p.getByTestId('template-preview')).toBeVisible();
      await p.waitForTimeout(400);
      await p.keyboard.press('Escape');
    },
  ],
  [
    'canvas selection, prompt panel and an agent-built node',
    (p) => open(p, '/p/prj_demo'),
    async (p) => {
      const video = p.locator('.react-flow__node').filter({ has: p.locator('[data-status]') }).nth(3);
      await video.click();
      await p.evaluate(() =>
        (window as unknown as { __canvasRoom: { remotePatch: (ops: unknown[], actor: string) => unknown } }).__canvasRoom.remotePatch(
          [{ op: 'addNode', tempId: 'motion1', kind: 'image', title: 'Built', params: {}, position: { x: 900, y: 640 } }],
          'agent',
        ),
      );
      await p.waitForTimeout(600);
    },
  ],
];

test.describe('reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  for (const [name, setup, act] of SURFACES) {
    test(`${name}: fades only, no loops, nothing over 200ms`, async ({ page }) => {
      await setup(page);
      const log = await during(page, () => act(page));
      expect(log.length, 'the surface should fade at least something').toBeGreaterThan(0);
      expect(reducedMotionViolations(log)).toEqual([]);
    });
  }
});

test.describe('motion tokens at runtime', () => {
  for (const [name, setup, act] of SURFACES) {
    test(`${name}: token durations and curves; exits shorter, on the exit curve`, async ({ page }) => {
      await setup(page);
      const log = await during(page, () => act(page));
      const off = log
        .filter((m) => !TOKEN_MS.includes(Math.round(m.duration)) || !CURVES.includes(m.easing))
        .map((m) => `${m.kind} ${m.name} on ${m.el}: ${Math.round(m.duration)}ms ${m.easing}`);
      expect([...new Set(off)]).toEqual([]);
      for (const m of log.filter((x) => x.kind === 'animation' && /-out$/.test(x.name))) {
        expect(m.easing, `${m.name} on ${m.el}`).toBe('cubic-bezier(0.4, 0, 1, 1)');
        expect(m.duration, `${m.name} on ${m.el}`).toBeLessThanOrEqual(140);
      }
    });
  }
});

test.describe('layout shift', () => {
  test('Home loads without layout shift (dark and light)', async ({ page }) => {
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await page.waitForTimeout(2000);
      const { total, shifts } = await layoutShift(page);
      expect(total, JSON.stringify(shifts)).toBeLessThan(0.01);
    }
  });

  test('Canvas loads without layout shift', async ({ page }) => {
    await open(page, '/p/prj_demo');
    await page.waitForTimeout(2000);
    const { total, shifts } = await layoutShift(page);
    expect(total, JSON.stringify(shifts)).toBeLessThan(0.01);
  });

  test('switching the theme changes colors only: no animation, no shift', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    await clearMotion(page);
    const before = await layoutShift(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(400);
    const moved = (await motionLog(page)).filter((m) => m.moves);
    expect(moved).toEqual([]);
    expect((await layoutShift(page)).total - before.total).toBeLessThan(0.001);
  });
});

test('canvas: the prompt panel tracks its node while the canvas pans (no glide behind it)', async ({ page }) => {
  await open(page, '/p/prj_demo');
  const node = page.locator('.react-flow__node').filter({ has: page.locator('[data-status]') }).nth(3);
  await node.click();
  const panel = page.getByTestId('prompt-panel');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(400);
  const gap = async () => {
    const n = (await node.boundingBox())!;
    const p = (await panel.boundingBox())!;
    return { dx: p.x - n.x, dy: p.y - (n.y + n.height) };
  };
  const before = { ...(await gap()), y: (await node.boundingBox())!.y };
  // The canvas pans on scroll; bottom middle is empty pane (the minimap and zoom controls sit at the left).
  await page.mouse.move(560, H - 40);
  await page.mouse.wheel(60, 80);
  await expect.poll(async () => (await node.boundingBox())!.y).not.toBe(before.y);
  // Two frames for React to place the panel, then read: a 320ms transition would still leave it far behind.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await gap();
  expect(Math.abs(after.dx - before.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.dy - before.dy)).toBeLessThanOrEqual(1);
});
