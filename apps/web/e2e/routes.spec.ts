import { expect, test } from '@playwright/test';

/** Every route in handoff section 1 renders its page title from messages/en.json. */
const ROUTES: Array<{ path: string; title: string; header: boolean; activeNav?: string }> = [
  { path: '/', title: 'Turn an idea into a video', header: true, activeNav: 'Home' },
  { path: '/login', title: 'Welcome back', header: false },
  { path: '/signup', title: 'Create your account', header: false },
  { path: '/p/prj_demo', title: 'Canvas', header: true, activeNav: 'Canvas' },
  { path: '/create/quick', title: 'Quick Create', header: true, activeNav: 'Quick Create' },
  { path: '/create/remix', title: 'Remix', header: true, activeNav: 'Remix' },
  { path: '/create/avatar', title: 'Avatar', header: true, activeNav: 'Avatar' },
  { path: '/create/character', title: 'Characters', header: true, activeNav: 'Characters' },
  { path: '/templates', title: 'Templates', header: true },
  { path: '/assets', title: 'Assets', header: true, activeNav: 'Assets' },
  { path: '/assets/public', title: 'Public library', header: true, activeNav: 'Assets' },
  { path: '/activity', title: 'Activity', header: true, activeNav: 'Activity' },
  { path: '/upgrade', title: 'Pick a plan to start creating', header: true },
  { path: '/settings/account', title: 'Settings', header: true },
  { path: '/u/alex', title: '@alex', header: true },
];

for (const r of ROUTES) {
  test(`route ${r.path} renders title "${r.title}"${r.header ? ' with the shared header' : ' without the header'}`, async ({ page }) => {
    await page.goto(r.path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(r.title);
    await expect(page.getByTestId('app-header')).toHaveCount(r.header ? 1 : 0);
    if (r.activeNav) {
      await expect(page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]')).toHaveText(r.activeNav);
    }
  });
}

test('/settings redirects to the default billing section', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Plans and billing');
});

test('unknown settings section and unknown path render "Page not found"', async ({ page }) => {
  await page.goto('/settings/nope');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
});

test('clicking a nav item navigates client-side and moves aria-current', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Activity' }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity');
  await expect(page.getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
});
