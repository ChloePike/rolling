/**
 * A tiny Markdown parser for the legal pages (no dependency). It covers what
 * `legal/*.md` uses: headings, paragraphs, bullet and numbered lists, tables,
 * block quotes, rules, and inline bold, italic, code and links. HTML comments
 * are dropped; raw HTML is never passed through (the renderer builds React
 * elements, so text is always escaped).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  /** Bracketed ALL-CAPS text such as `[COMPANY LEGAL NAME]`: a value the owner still has to fill. */
  | { t: 'placeholder'; v: string };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; id: string; text: string; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Plain text of inline nodes (heading ids, document titles). */
export function plainText(nodes: Inline[]): string {
  return nodes.map((n) => ('c' in n ? plainText(n.c) : n.v)).join('');
}

const PLACEHOLDER = /^\[([A-Z][A-Z0-9 ,./:;'"()&+-]*(?:[a-z][^\]]*)?)\]/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if (rest.startsWith('`') && (m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
      i += m[0].length;
    } else if (rest.startsWith('**') && (m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush();
      out.push({ t: 'strong', c: parseInline(m[1]!) });
      i += m[0].length;
    } else if (/^\*[^*\s]/.test(rest) && (m = rest.match(/^\*([^*]+?)\*/))) {
      flush();
      out.push({ t: 'em', c: parseInline(m[1]!) });
      i += m[0].length;
    } else if (rest.startsWith('[') && (m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      out.push({ t: 'link', href: m[2]!, c: parseInline(m[1]!) });
      i += m[0].length;
    } else if (rest.startsWith('[') && (m = rest.match(PLACEHOLDER))) {
      flush();
      out.push({ t: 'placeholder', v: m[0] });
      i += m[0].length;
    } else {
      text += src[i];
      i += 1;
    }
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isTableDivider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const blocks: Block[] = [];
  const used = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const c = parseInline(h[2]!.trim());
      const text = plainText(c);
      const base = slugify(text) || 'section';
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      blocks.push({ t: 'heading', level: h[1]!.length as 1 | 2 | 3 | 4, id: n ? `${base}-${n}` : base, text, c });
      i += 1;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) inner.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n')) });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]!)) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(splitRow(lines[i++]!).map(parseInline));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const l = lines[i]!;
        if (LIST_ITEM.test(l)) {
          // A different list kind starts a new list.
          if (/^\s*\d+\./.test(l) !== ordered) break;
          items.push(l.replace(LIST_ITEM, ''));
        } else if (/^\s+\S/.test(l)) {
          // Indented continuation of the previous item.
          items[items.length - 1] += ` ${l.trim()}`;
        } else break;
        i += 1;
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map(parseInline) });
      continue;
    }
    // Paragraph: consecutive lines; each source line break is kept as a line break.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|>|\s*\|)/.test(lines[i]!) && !LIST_ITEM.test(lines[i]!)) para.push(lines[i++]!.trim());
    const c: Inline[] = [];
    para.forEach((p, n) => {
      if (n) c.push({ t: 'text', v: '\n' });
      c.push(...parseInline(p));
    });
    blocks.push({ t: 'p', c });
  }
  return blocks;
}
