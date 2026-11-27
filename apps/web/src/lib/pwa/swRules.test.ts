import { describe, expect, it } from 'vitest';
import { isAppNavigation, isOnDemandChunk, isRuntimeStatic } from './swRules';

const ORIGIN = 'https://rolling.actor';
const nav = (url: string, method = 'GET') => ({ url, method, mode: 'navigate' });
const get = (url: string, destination: string, method = 'GET') => ({ url, method, destination });

describe('service worker rules', () => {
  it('answers SPA navigations with the app shell', () => {
    for (const path of ['/', '/activity', '/p/prj_1', '/settings/billing', '/u/alex', '/login?redirect=%2F']) {
      expect(isAppNavigation(nav(`${ORIGIN}${path}`), ORIGIN), path).toBe(true);
    }
  });

  it('never takes over API, auth callbacks, media or file navigations', () => {
    for (const path of ['/api/auth/google/start', '/api/ws', '/api/graphql', '/api', '/media/ast_1?sig=x', '/sw.js', '/manifest.webmanifest', '/icons/app-icon-512.png']) {
      expect(isAppNavigation(nav(`${ORIGIN}${path}`), ORIGIN), path).toBe(false);
    }
    // Google's redirect-mode sign-in posts the credential to the API (D-017).
    expect(isAppNavigation(nav(`${ORIGIN}/api/auth/google/credential`, 'POST'), ORIGIN)).toBe(false);
    expect(isAppNavigation(nav(`${ORIGIN}/`, 'POST'), ORIGIN)).toBe(false);
    expect(isAppNavigation({ url: `${ORIGIN}/activity`, method: 'GET', mode: 'cors' }, ORIGIN)).toBe(false);
  });

  it('never handles cross-origin requests (media hosts, R2 presigned uploads, Google, Stripe)', () => {
    const others = [
      'https://media.rolling.actor/lib/a.jpg',
      'https://media-staging.rolling.actor/x.png',
      'https://cdn-private.rolling.actor/ast_1.mp4?exp=1&sig=2',
      'https://acc.r2.cloudflarestorage.com/rolling-media/upl_1?X-Amz-Signature=abc',
      'https://accounts.google.com/gsi/client',
      'https://checkout.stripe.com/c/pay/cs_test',
      'https://js.stripe.com/v3',
    ];
    for (const url of others) {
      expect(isAppNavigation(nav(url), ORIGIN), url).toBe(false);
      expect(isRuntimeStatic(get(url, 'image'), ORIGIN), url).toBe(false);
      expect(isRuntimeStatic(get(url, 'font'), ORIGIN), url).toBe(false);
    }
  });

  it('runtime-caches only same-origin fonts and static images without a query', () => {
    expect(isRuntimeStatic(get(`${ORIGIN}/assets/geist.woff2`, 'font'), ORIGIN)).toBe(true);
    expect(isRuntimeStatic(get(`${ORIGIN}/model-icons/new.svg`, 'image'), ORIGIN)).toBe(true);
    expect(isRuntimeStatic(get(`${ORIGIN}/icons/app-icon-1024.png`, 'image'), ORIGIN)).toBe(true);
    expect(isRuntimeStatic(get(`${ORIGIN}/media/ast_1.png`, 'image'), ORIGIN)).toBe(false);
    expect(isRuntimeStatic(get(`${ORIGIN}/api/me/avatar.png`, 'image'), ORIGIN)).toBe(false);
    expect(isRuntimeStatic(get(`${ORIGIN}/icons/x.png?v=2`, 'image'), ORIGIN)).toBe(false);
    expect(isRuntimeStatic(get(`${ORIGIN}/api/me`, ''), ORIGIN)).toBe(false);
    expect(isRuntimeStatic(get(`${ORIGIN}/assets/app.js`, 'script'), ORIGIN)).toBe(false);
    expect(isRuntimeStatic(get(`${ORIGIN}/icons/a.png`, 'image', 'PUT'), ORIGIN)).toBe(false);
  });

  it('runtime-caches the chunks left out of the precache (translations, admin console)', () => {
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/locales/ja-BaS5QclZ.js`, 'script'), ORIGIN)).toBe(true);
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/admin/users-Ab12_cd.js`, 'script'), ORIGIN)).toBe(true);
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/admin/users-Ab12_cd.css`, 'style'), ORIGIN)).toBe(true);
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/index-Ab12.js`, 'script'), ORIGIN)).toBe(false);
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/locales/ja.js?v=1`, 'script'), ORIGIN)).toBe(false);
    expect(isOnDemandChunk(get(`https://media.rolling.actor/assets/locales/ja.js`, 'script'), ORIGIN)).toBe(false);
    expect(isOnDemandChunk(get(`${ORIGIN}/api/assets/locales/ja.js`, 'script'), ORIGIN)).toBe(false);
    expect(isOnDemandChunk(get(`${ORIGIN}/assets/locales/ja.js`, 'script', 'POST'), ORIGIN)).toBe(false);
  });
});
