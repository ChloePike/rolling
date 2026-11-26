import { beforeEach, describe, expect, it, vi } from 'vitest';
import { incomingParams, saveIncoming, takeIncoming } from './incoming';

describe('incoming items', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });

  it('hands an item over once, to the right project', () => {
    const token = saveIncoming('prj_a', [{ name: 'Pack front', media: 'image', refId: 'ast_1', assetId: 'ast_1' }]);
    expect(takeIncoming(token, 'prj_b')).toBeNull();
    const again = saveIncoming('prj_a', [{ name: 'Pack front', media: 'image', refId: 'ast_1' }]);
    expect(takeIncoming(again, 'prj_a')).toHaveLength(1);
    expect(takeIncoming(again, 'prj_a')).toBeNull();
  });

  it('builds asset node params with provenance', () => {
    expect(incomingParams({ name: 'x', media: 'video', refId: 'ast_2', assetId: 'ast_2', source: 'mine', label: '5s' })).toEqual({
      media: 'video',
      label: '5s',
      tone: 'var(--c-tone-indigo)',
      refId: 'ast_2',
      assetId: 'ast_2',
      source: 'upload',
    });
    expect(incomingParams({ name: 'x', media: 'image', refId: 'pw_1', source: 'public' })).not.toHaveProperty('assetId');
  });
});
