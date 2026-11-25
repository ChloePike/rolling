import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { contentTypeOf, validateUpload } from './config';
import { fingerprint } from './fingerprint';
import { IdbChunkStore, IdbPersistence, openTransfersDb, type PersistedRecord } from './store';

const MiB = 1024 * 1024;

describe('fingerprint', () => {
  it('is stable for the same file and changes with name, lastModified, head or tail bytes', async () => {
    const bytes = new Uint8Array(3 * MiB).map((_, i) => i % 251);
    const a = await fingerprint(new Blob([bytes]), 'clip.mp4', 1);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fingerprint(new Blob([bytes]), 'clip.mp4', 1)).toBe(a);
    expect(await fingerprint(new Blob([bytes]), 'clip2.mp4', 1)).not.toBe(a);
    expect(await fingerprint(new Blob([bytes]), 'clip.mp4', 2)).not.toBe(a);
    const tail = bytes.slice();
    tail[tail.length - 1] = 7;
    expect(await fingerprint(new Blob([tail]), 'clip.mp4', 1)).not.toBe(a);
    const head = bytes.slice();
    head[0] = 9;
    expect(await fingerprint(new Blob([head]), 'clip.mp4', 1)).not.toBe(a);
    // Only the first and last MiB are sampled (documented trade-off).
    const middle = bytes.slice();
    middle[Math.floor(1.5 * MiB)] = 3;
    expect(await fingerprint(new Blob([middle]), 'clip.mp4', 1)).toBe(a);
  });

  it('handles files smaller than the sample', async () => {
    expect(await fingerprint(new Blob(['tiny']), 'a.png', 0)).toMatch(/^sha256:/);
  });
});

describe('validation', () => {
  it('applies the per-kind limits client-side', () => {
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 30 * MiB })).toMatchObject({ ok: true, kind: 'image' });
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 30 * MiB + 1 })).toMatchObject({ ok: false, reason: 'TOO_LARGE', maxBytes: 30 * MiB });
    expect(validateUpload({ name: 'a.mov', type: 'video/quicktime', size: 2048 * MiB })).toMatchObject({ ok: true, kind: 'video' });
    expect(validateUpload({ name: 'a.mp4', type: 'video/mp4', size: 2048 * MiB + 1 })).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    expect(validateUpload({ name: 'a.wav', type: 'audio/wav', size: 201 * MiB })).toMatchObject({ ok: false, reason: 'TOO_LARGE' });
    expect(validateUpload({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toMatchObject({ ok: false, reason: 'UNSUPPORTED_TYPE' });
    expect(validateUpload({ name: 'a.png', type: 'image/png', size: 0 })).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(contentTypeOf({ name: 'Clip.MOV', type: '' })).toBe('video/quicktime');
  });
});

describe('IndexedDB persistence', () => {
  it('round-trips records, blobs and chunks', async () => {
    const db = (await openTransfersDb())!;
    expect(db).toBeTruthy();
    const p = new IdbPersistence(db);
    const rec: PersistedRecord = {
      id: 'upl_1',
      owner: 'eng_a',
      item: {
        id: 'upl_1',
        kind: 'upload',
        name: 'a.png',
        size: 10,
        contentType: 'image/png',
        status: 'running',
        priority: 'normal',
        bytesDone: 0,
        speed: 0,
        eta: null,
        createdAt: 1,
        updatedAt: 1,
        userPaused: false,
      },
      upload: { assetId: 'ast_1', partSize: 8 * MiB, partCount: 1, etags: { 1: '"e1"' } },
    };
    await p.save(rec);
    expect(await p.loadAll()).toEqual([rec]);
    expect(await p.putBlob('upl_1', new Blob(['hello']))).toBe(true);
    expect(await (await p.getBlob('upl_1'))!.text()).toBe('hello');
    await p.remove('upl_1');
    expect(await p.loadAll()).toEqual([]);
    expect(await p.getBlob('upl_1')).toBeUndefined();

    const c = new IdbChunkStore(db);
    await c.put('dl_1', 1, new Blob(['world']));
    await c.put('dl_1', 0, new Blob(['hello ']));
    await c.put('dl_10', 0, new Blob(['other']));
    expect(await (await c.assemble('dl_1', 2)).text()).toBe('hello world');
    await c.delete('dl_1');
    expect(await c.get('dl_1', 0)).toBeUndefined();
    expect(await (await c.get('dl_10', 0))!.text()).toBe('other');
  });
});
