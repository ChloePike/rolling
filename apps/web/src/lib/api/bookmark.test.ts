import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, BOOKMARK_HEADER, getBookmark, noteBookmark, setFetchForTests } from './client';

/** D1 read replication: the client keeps the newest `x-d1-bookmark` and sends it back (apps/api/src/lib/d1Session.ts). */
describe('lib/api: D1 bookmarks', () => {
  const B1 = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  const B2 = '00000085-0000024c-00004c6e-0000000000000000000000000000beef';
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  });
  afterEach(() => {
    setFetchForTests(null);
    vi.unstubAllGlobals();
  });

  it('stores the bookmark from a response and sends it on the next request', async () => {
    const sent: (string | null)[] = [];
    let reply = B1;
    setFetchForTests(async (_url, init) => {
      sent.push(new Headers(init?.headers).get(BOOKMARK_HEADER));
      return new Response('{}', { status: 200, headers: { [BOOKMARK_HEADER]: reply } });
    });
    await api.patch('/me/prefs', { theme: 'dark' });
    reply = B2;
    await api.get('/me');
    expect(sent[1]).toBe(B1);
    await api.get('/projects');
    expect(sent[2]).toBe(B2);
    expect(store.get('rolling.d1b')).toBe(B2);
  });

  it('never goes back to an older bookmark (a slower parallel read cannot undo a write)', () => {
    noteBookmark(B2);
    noteBookmark(B1);
    expect(getBookmark()).toBe(B2);
  });

  it('picks up a newer bookmark written by another tab', () => {
    noteBookmark(B1);
    store.set('rolling.d1b', B2);
    expect(getBookmark()).toBe(B2);
  });
});
