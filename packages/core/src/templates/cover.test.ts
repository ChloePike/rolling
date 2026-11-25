import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtin';
import { COVER_TOKENS, coverSize, templateCoverKey, templateCoverSvg } from './cover';

describe('template covers', () => {
  it('keys covers under public/templates/<id>/cover.png and refuses other ids', () => {
    expect(templateCoverKey('tpl_tv_ad_15s')).toBe('public/templates/tpl_tv_ad_15s/cover.png');
    expect(() => templateCoverKey('../ws/x')).toThrow();
  });

  it('sizes covers by the template ratio', () => {
    expect(coverSize('16:9')).toEqual({ width: 720, height: 405 });
    expect(coverSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(coverSize('1:1')).toEqual({ width: 720, height: 720 });
  });

  it('draws every node title and the template title with token colors only (no gradients, no brand yellow)', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const svg = templateCoverSvg(t);
      const { width, height } = coverSize(t.meta.ratio);
      expect(svg).toContain(`width="${width}" height="${height}"`);
      for (const n of t.graph.nodes) expect(svg).toContain(`>${n.title.replace(/&/g, '&amp;')}<`);
      expect(svg).toContain(t.title.replace(/&/g, '&amp;'));
      expect(svg).not.toMatch(/Gradient|filter=|#FFCB2B/i);
      const colors = new Set(svg.match(/#[0-9A-Fa-f]{6}\b/g));
      const allowed = new Set<string>(Object.values(COVER_TOKENS));
      for (const c of colors) expect(allowed.has(c)).toBe(true);
    }
  });

  it('escapes text', () => {
    const t = BUILTIN_TEMPLATES[0]!;
    const svg = templateCoverSvg({ ...t, title: 'Fish & <chips>' });
    expect(svg).toContain('Fish &amp; &lt;chips&gt;');
  });
});
