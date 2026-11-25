/* Dev helper: renders design + app for each tool state, prints pixel diffs, writes side-by-side PNGs. */
import { chromium, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pixelDiffRatio } from '../../support/measure';
import { buildToolDesignPage } from './design-tools';
import { APP_HEADER, DESIGN_HEADER, HEIGHT, TOOL_STATES, WIDTH } from './states';

const base = process.env.APP_URL ?? 'http://localhost:5199';
const out = process.argv[2] ?? '.';
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const PRE = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch(existsSync(PRE) ? { executablePath: PRE } : {});
const page: Page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'dark' });
await page.addInitScript('window.__name = (f) => f');
for (const s of TOOL_STATES.filter((x) => !only.length || only.some((o) => x.id.startsWith(o)))) {
  const body = s.crop === 'body';
  const dh = body ? HEIGHT - (APP_HEADER - DESIGN_HEADER) : HEIGHT;
  await page.setViewportSize({ width: WIDTH, height: dh });
  await page.setContent(buildToolDesignPage(s.design));
  await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
  await page.evaluate(() => document.fonts.ready);
  const dclip = body ? { x: 0, y: DESIGN_HEADER, width: WIDTH, height: dh - DESIGN_HEADER } : { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const design = await page.screenshot({ clip: dclip });
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.goto(base + '/');
  await page.evaluate((m) => localStorage.setItem('rolling.creationMode', m), s.mode);
  await page.goto(base + s.path);
  await page.locator(`[data-testid="tool-${s.tool}"]`).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(5, 895);
  if (s.open) await s.open(page);
  await page.mouse.move(5, 895);
  await page.waitForTimeout(450);
  const aclip = body ? { x: 0, y: APP_HEADER, width: WIDTH, height: HEIGHT - APP_HEADER } : { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const app = await page.screenshot({ clip: aclip, animations: 'disabled' });
  await page.evaluate('window.__name = (f) => f');
  const ratio = await pixelDiffRatio(page, app, design);
  writeFileSync(`${out}/${s.id}-app.png`, app);
  writeFileSync(`${out}/${s.id}-design.png`, design);
  let extra = '';
  if (s.mode === 'advanced') {
    // Advanced settings run below the fold: compare the left panel scrolled to the end.
    const clipA = { x: 0, y: APP_HEADER, width: 340, height: HEIGHT - APP_HEADER };
    await page.evaluate(() => { const a = document.querySelector('main aside')!; a.scrollTop = a.scrollHeight; });
    await page.waitForTimeout(100);
    const appA = await page.screenshot({ clip: clipA, animations: 'disabled' });
    const scrollA = await page.evaluate(() => document.querySelector('main aside')!.scrollHeight);
    await page.setViewportSize({ width: WIDTH, height: HEIGHT - (APP_HEADER - DESIGN_HEADER) });
    await page.setContent(buildToolDesignPage(s.design));
    await page.waitForFunction(() => (window as unknown as { __DC_READY__?: boolean }).__DC_READY__ === true);
    await page.evaluate(() => document.fonts.ready);
    const scrollD = await page.evaluate(() => { const a = document.querySelector('aside')!; a.scrollTop = a.scrollHeight; return a.scrollHeight; });
    const desA = await page.screenshot({ clip: { x: 0, y: DESIGN_HEADER, width: 340, height: HEIGHT - APP_HEADER } });
    await page.evaluate('window.__name = (f) => f');
    const r2 = await pixelDiffRatio(page, appA, desA);
    writeFileSync(`${out}/${s.id}-aside-app.png`, appA);
    writeFileSync(`${out}/${s.id}-aside-design.png`, desA);
    extra = `  aside-bottom ${(r2 * 100).toFixed(3)}% (scrollHeight app ${scrollA} design ${scrollD})`;
  }
  console.log(s.id.padEnd(22), (ratio * 100).toFixed(3) + '%' + extra);
}
await browser.close();
