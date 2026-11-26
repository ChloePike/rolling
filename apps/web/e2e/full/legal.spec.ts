import { expect, test } from '@playwright/test';
import { shot, watchErrors } from './support';

/** Matrix: LEGAL-1 … LEGAL-4 (staging; the same checks run on production in prod.spec.ts). */
export const LEGAL = [
  { path: '/privacy', heading: /Privacy/ },
  { path: '/terms', heading: /Terms/ },
  { path: '/acceptable-use', heading: /Acceptable use/i },
  { path: '/subprocessors', heading: /Subprocessors/i },
];

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

for (const doc of LEGAL) {
  test(`LEGAL-1 ${doc.path} returns the full document as static HTML (no JavaScript needed)`, async ({ request }) => {
    const r = await request.get(doc.path);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('text/html');
    const html = await r.text();
    expect(html).toMatch(/<h1[^>]*>/i);
    const text = visibleText(html);
    expect(text).toMatch(doc.heading);
    expect(text.length, `${doc.path}: static text length`).toBeGreaterThan(2000);
    expect(html).toMatch(/<title>[^<]*(Privacy|Terms|Acceptable|Subprocessors)/i);
    expect(html).toMatch(/<link[^>]+rel="canonical"/i);
  });
}

test('LEGAL-2 legal pages render in the browser signed out, with no console errors; /legal/<doc> redirects', async ({ page }, testInfo) => {
  const errs = watchErrors(page);
  for (const doc of LEGAL) {
    await page.goto(doc.path);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(doc.heading);
    await expect(page).toHaveURL(new RegExp(`${doc.path}$`));
  }
  await shot(page, testInfo, 'legal');
  await page.goto('/legal/privacy');
  await expect(page).toHaveURL(/\/privacy$/);
  errs.assertClean();
});

test('LEGAL-3 robots.txt and sitemap.xml', async ({ request, baseURL }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  const rt = await robots.text();
  expect(rt).toMatch(/User-agent:/i);
  expect(rt).toMatch(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/i);
  const sm = await request.get('/sitemap.xml');
  expect(sm.status()).toBe(200);
  expect(sm.headers()['content-type']).toMatch(/xml/);
  const xml = await sm.text();
  for (const doc of LEGAL) expect(xml).toContain(`${doc.path}</loc>`);
  // Staging must not be indexed.
  if (/staging/.test(baseURL ?? '')) expect(rt).toMatch(/Disallow:\s*\/\s*$/m);
});

test('LEGAL-4 the login consent line and the plans page link the legal pages', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  await page.goto('/upgrade');
  await expect(page.getByTestId('legal-links')).toBeVisible();
});
