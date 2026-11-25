import { describe, expect, it } from 'vitest';
import { coverStyle } from './cover';

describe('coverStyle', () => {
  it('shows the cover picture over the tone, or the tone alone', () => {
    expect(coverStyle('/api/media/public/templates/tpl_a/cover.png', 'var(--c-tone-plum)', { aspectRatio: '9/16' })).toEqual({
      backgroundColor: 'var(--c-tone-plum)',
      backgroundImage: 'url("/api/media/public/templates/tpl_a/cover.png")',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      aspectRatio: '9/16',
    });
    expect(coverStyle(null, 'var(--c-tone-teal)')).toEqual({ background: 'var(--c-tone-teal)' });
    expect(coverStyle('https://m/x".png', 't').backgroundImage).toBe('url("https://m/x%22.png")');
  });
});
