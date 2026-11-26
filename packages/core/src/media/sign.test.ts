import { describe, expect, it } from 'vitest';
import { checkUpload, safeFilename } from './limits';
import { signMediaKey, verifyMediaSignature } from './sign';

const secret = 'test-secret';

function parse(url: string) {
  const u = new URL(url, 'https://x.test');
  const key = u.pathname.replace(/^\/media\//, '').split('/').map(decodeURIComponent).join('/');
  return { key, q: { exp: u.searchParams.get('exp'), ws: u.searchParams.get('ws'), sig: u.searchParams.get('sig') } };
}

describe('signed media URLs', () => {
  it('verifies, expires and rejects tampering', async () => {
    const now = 1_700_000_000_000;
    const url = await signMediaKey('ws/ws_A/uploads/ast_1/a b.png', { workspaceId: 'ws_A', expiresIn: 60, secret, now });
    const { key, q } = parse(url);
    expect(key).toBe('ws/ws_A/uploads/ast_1/a b.png');
    expect(await verifyMediaSignature(key, q, secret, now)).toMatchObject({ ok: true });
    expect(await verifyMediaSignature(key, q, secret, now + 61_000)).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyMediaSignature('ws/ws_A/uploads/ast_2/a.png', q, secret, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyMediaSignature(key, { ...q, ws: 'ws_B' }, secret, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyMediaSignature(key, { ...q, exp: String(Number(q.exp) + 100) }, secret, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyMediaSignature(key, q, 'other', now)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('aligns the expiry so URLs are stable inside a window', async () => {
    const t = 1_700_000_000_000;
    const a = await signMediaKey('public/pose/x/front.webp', { workspaceId: '_', expiresIn: 3600, alignSeconds: 3600, secret, now: t });
    const b = await signMediaKey('public/pose/x/front.webp', { workspaceId: '_', expiresIn: 3600, alignSeconds: 3600, secret, now: t + 60_000 });
    expect(a).toBe(b);
    const exp = Number(parse(a).q.exp);
    expect(exp % 3600).toBe(0);
    expect(exp - t / 1000).toBeGreaterThanOrEqual(3600);
    expect(exp - t / 1000).toBeLessThanOrEqual(7200);
  });

  it('refuses to sign keys of another workspace', async () => {
    await expect(signMediaKey('ws/ws_B/x.png', { workspaceId: 'ws_A', expiresIn: 60, secret })).rejects.toThrow();
  });
});

describe('upload limits', () => {
  it('applies per-kind limits', () => {
    expect(checkUpload('image/png', 30 * 1024 * 1024)).toMatchObject({ ok: true, kind: 'image' });
    expect(checkUpload('image/png', 30 * 1024 * 1024 + 1)).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    expect(checkUpload('video/mp4', 2048 * 1024 * 1024)).toMatchObject({ ok: true, parts: 256 });
    expect(checkUpload('audio/mpeg', 201 * 1024 * 1024)).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    expect(checkUpload('application/pdf', 10)).toMatchObject({ ok: false, reason: 'UNSUPPORTED_TYPE' });
    expect(safeFilename('../../etc/pass wd.png')).toBe('pass-wd.png');
  });
});
