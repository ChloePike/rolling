import { expect, test } from '@playwright/test';
import { account, api, env, getJson, SAMPLE_OPS, seedProject, shot, watchErrors } from './support';

/** Matrix: SHARE-1 … SHARE-3. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

test('SHARE-1 share link: create from the Share dialog, opens signed out as a read-only board; revoke shows “isn’t available”', async ({ page, context, baseURL, browser }, testInfo) => {
  await account(context, baseURL, 'share');
  const p = await seedProject(page.request, baseURL, 'Shared canvas', SAMPLE_OPS);
  await page.goto(`/p/${p.id}`);
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: /Share|link/i }).first();
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'share-dialog');
  // First share of a never-shared canvas: the dialog should not talk about an “old link”.
  const firstNote = await dialog.getByRole('status').first().innerText();
  testInfo.annotations.push({ type: 'first-share-note', description: firstNote });
  expect(firstNote).toMatch(/Not shared yet/);
  expect((await getJson<{ enabled: boolean; revoked: boolean }>(page.request, `/api/projects/${p.id}/share`)).revoked).toBe(false);
  await expect(dialog.getByTestId('share-link')).toHaveText('No link yet');
  await expect(dialog.getByRole('button', { name: 'Share again' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Publish snapshot' }).click();
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeEnabled({ timeout: 20_000 });
  await expect(dialog.getByTestId('share-link')).toBeVisible({ timeout: 20_000 });
  const share = await getJson<{ enabled: boolean; shareId: string; url: string }>(page.request, `/api/projects/${p.id}/share`);
  expect(share.enabled).toBe(true);
  expect(new URL(share.url).pathname).toBe(`/share/${share.shareId}`);
  const anon = await browser.newContext({ baseURL });
  const ap = await anon.newPage();
  const errs = watchErrors(ap);
  await ap.goto(new URL(share.url).pathname);
  await expect(ap.getByTestId('share-board')).toBeVisible({ timeout: 30_000 });
  await expect(ap.getByText('Shot A').first()).toBeVisible();
  await expect(ap.getByRole('button', { name: /Run all/ })).toHaveCount(0);
  await shot(ap, testInfo, 'share-public');
  errs.assertClean();
  const api1 = await anon.request.get(`/api/share/${share.shareId}`);
  expect(api1.status()).toBe(200);
  // Revoke.
  expect((await api(page.request, baseURL, 'DELETE', `/api/projects/${p.id}/share`)).status()).toBe(200);
  await ap.reload();
  await expect(ap.getByTestId('share-missing')).toBeVisible({ timeout: 30_000 });
  expect(firstNote, 'a canvas that was never shared does not say “The old link no longer opens”').not.toMatch(/old link/);
  // After stopping, the owner's state is “stopped” (revoked), not first-share.
  expect(await getJson<{ enabled: boolean; revoked: boolean }>(page.request, `/api/projects/${p.id}/share`)).toMatchObject({ enabled: false, revoked: true });
  await page.reload();
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog').filter({ hasText: /Share/ }).first().getByRole('status').first()).toContainText('The old link no longer opens');
  expect((await anon.request.get(`/api/share/${share.shareId}`)).status()).toBe(404);
  await anon.close();
});

test('SHARE-2 public profile /u/:handle: signed out, shows name, bio and works shown on the profile; unknown handles show unavailable', async ({ page, context, baseURL, browser }, testInfo) => {
  await account(context, baseURL, 'profilepub');
  const handle = `fullp${Date.now().toString(36)}`;
  const set = await api(page.request, baseURL, 'PATCH', '/api/me/profile', { name: 'Profile Person', handle, bio: 'Makes short ads' });
  expect(set.status(), await set.text()).toBe(200);
  const p = await seedProject(page.request, baseURL, 'On profile', SAMPLE_OPS);
  const sh = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/share`, { showOnProfile: true });
  expect(sh.status(), await sh.text()).toBe(201);
  const anon = await browser.newContext({ baseURL });
  const ap = await anon.newPage();
  await ap.goto(`/u/${handle.toUpperCase()}`);
  await expect(ap.getByText('Profile Person').first()).toBeVisible({ timeout: 30_000 });
  await expect(ap.getByText('Makes short ads')).toBeVisible();
  await shot(ap, testInfo, 'profile');
  const prof = await getJson<{ handle: string; works: unknown[] }>(anon.request, `/api/profiles/${handle}`);
  expect(prof.handle).toBe(handle);
  await ap.goto('/u/nobody-here-zz9');
  await expect(ap.getByTestId('profile-unavailable')).toBeVisible({ timeout: 30_000 });
  await anon.close();
});

test('SHARE-3 workspace-only links need a member session', async ({ page, context, baseURL, browser }) => {
  await account(context, baseURL, 'shareaud');
  const p = await seedProject(page.request, baseURL, 'Members only', SAMPLE_OPS);
  const sh = await api(page.request, baseURL, 'POST', `/api/projects/${p.id}/share`, { audience: 'workspace' });
  expect(sh.status(), await sh.text()).toBe(201);
  const { shareId } = (await sh.json()) as { shareId: string };
  expect((await page.request.get(`/api/share/${shareId}`)).status()).toBe(200);
  const anon = await browser.newContext({ baseURL });
  expect((await anon.request.get(`/api/share/${shareId}`)).status()).toBe(404);
  await anon.close();
});
