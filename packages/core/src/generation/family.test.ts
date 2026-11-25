import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { familyFallbacks, modelFamily } from './auto';

describe('same-family fallbacks', () => {
  it('derives the vendor/family from a gateway id', () => {
    expect(modelFamily('bytedance/seedream-5.0-lite')).toBe('bytedance/seedream');
    expect(modelFamily('bytedance/seedance-2.5')).toBe('bytedance/seedance');
    expect(modelFamily('lumina/berry-1.0-turbo')).toBe('lumina/berry');
  });

  it('offers capable siblings of the same family, cheapest first, never another family', () => {
    const chosen = fixtureCatalog.get('bytedance/seedream-5.0-lite')!;
    const out = familyFallbacks(fixtureCatalog, chosen, { kind: 'image', mode: 't2i', ratio: '9:16' }, 'starter');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.id.startsWith('bytedance/seedream-') && m.id !== chosen.id)).toBe(true);
  });
});
