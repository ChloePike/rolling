import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS, legalBlocks } from './docs';
import { parseInline, parseMarkdown, slugify, type Block, type Inline } from './markdown';

function inlines(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      out.push(n);
      if ('c' in n) walk(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === 'heading' || b.t === 'p') walk(b.c);
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(walk);
    else if (b.t === 'table') [...b.head, ...b.rows.flat()].forEach(walk);
    else if (b.t === 'quote') out.push(...inlines(b.c));
  }
  return out;
}

describe('legal markdown parser', () => {
  it('parses headings with unique slugs, lists, tables, quotes and comments', () => {
    const blocks = parseMarkdown(
      [
        '<!-- hidden -->',
        '# Title',
        '> **Draft** note',
        '## Who we are',
        'Line one',
        'line two',
        '- a',
        '- b',
        '1. one',
        '2. two',
        '| A | B |',
        '|---|---|',
        '| x | `y` |',
        '## Who we are',
        '---',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'quote', 'heading', 'p', 'ul', 'ol', 'table', 'heading', 'hr']);
    expect(blocks.filter((b) => b.t === 'heading').map((b) => (b as { id: string }).id)).toEqual(['title', 'who-we-are', 'who-we-are-1']);
    expect(JSON.stringify(blocks)).not.toContain('hidden');
    const p = blocks[3] as Extract<Block, { t: 'p' }>;
    expect(p.c).toEqual([{ t: 'text', v: 'Line one' }, { t: 'text', v: '\n' }, { t: 'text', v: 'line two' }]);
  });

  it('parses inline marks, links and placeholders; never raw HTML', () => {
    expect(parseInline('**bold** and *it* [Terms](/terms) [COMPANY LEGAL NAME] [MINIMUM AGE, e.g. 13] <b>x</b>')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' and ' },
      { t: 'em', c: [{ t: 'text', v: 'it' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: '/terms', c: [{ t: 'text', v: 'Terms' }] },
      { t: 'text', v: ' ' },
      { t: 'placeholder', v: '[COMPANY LEGAL NAME]' },
      { t: 'text', v: ' ' },
      { t: 'placeholder', v: '[MINIMUM AGE, e.g. 13]' },
      { t: 'text', v: ' <b>x</b>' },
    ]);
    expect(slugify('How we use data and our legal bases')).toBe('how-we-use-data-and-our-legal-bases');
    expect(slugify('Plans and credits (Team)')).toBe('plans-and-credits-team');
  });
});

describe('legal documents', () => {
  const paths = new Set<string>([...LEGAL_DOCS.map((d) => d.path), '/upgrade']);

  for (const doc of LEGAL_DOCS) {
    it(`${doc.id}: title, no draft banner or open placeholders, links resolve`, () => {
      const blocks = legalBlocks(doc.id);
      expect(blocks[0]).toMatchObject({ t: 'heading', level: 1 });
      // Google's OAuth review reads these pages: no "draft" banner, no unresolved [PLACEHOLDER]s (internal notes are HTML comments).
      expect(JSON.stringify(blocks)).not.toContain('Draft for legal review');
      expect(inlines(blocks).filter((n) => n.t === 'placeholder')).toEqual([]);
      const ids = new Set(blocks.flatMap((b) => (b.t === 'heading' ? [b.id] : [])));
      for (const n of inlines(blocks)) {
        if (n.t !== 'link') continue;
        if (n.href.startsWith('#')) expect(ids, n.href).toContain(n.href.slice(1));
        else if (n.href.startsWith('/')) expect(paths, n.href).toContain(n.href.split('#')[0]);
        else expect(n.href).toMatch(/^https:\/\//);
      }
      expect(doc.source).not.toContain('/legal/');
    });
  }

  it('the privacy policy has the deletion section the Settings dialog links to', () => {
    expect(legalBlocks('privacy').some((b) => b.t === 'heading' && b.id === 'when-you-delete-your-account')).toBe(true);
  });

  it('the privacy policy has the Google user data section with the Limited Use statement', () => {
    const blocks = legalBlocks('privacy');
    expect(blocks.some((b) => b.t === 'heading' && b.id === 'google-user-data')).toBe(true);
    const text = JSON.stringify(blocks);
    for (const s of ['openid', 'Limited Use', 'do not sell', 'privacy@rolling.actor', 'Effective date: 26 November 2026']) expect(text).toContain(s);
  });
});
