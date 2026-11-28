/**
 * Agent reply text in the canvas agent panel (pure helpers, unit tested in
 * `agentText.test.ts`): the small Markdown subset the agent writes, rendered
 * as text nodes only, and the mock agent's small-talk check.
 */

export type Inline = { text: string; bold?: boolean; code?: boolean };
export type Block = { type: 'p'; parts: Inline[] } | { type: 'ul' | 'ol'; items: Inline[][] };

/** `**bold**` and `` `code` `` spans; anything else stays text (never HTML). */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2]!, code: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/**
 * The small Markdown subset the agent writes: paragraphs (blank-line separated,
 * single newlines kept), `-`/`*` bullet lists, `1.` numbered lists and inline
 * bold/code. Headings lose their `#`. Rendered as text nodes only.
 */
export function parseAgentText(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: Inline[][] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', parts: parseInline(para.join('\n')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(parseInline((bullet ?? numbered)![1]!));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flushPara();
  flushList();
  return blocks;
}

/** Mock mode only: a message that is not a brief (greeting, thanks, a question about the agent). */
export function isSmallTalk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,\s]+$/g, '');
  if (!t) return true;
  if (/^(hi|hello|hey|yo|hiya|thanks|thank you|thx|ok|okay|cool|good (morning|afternoon|evening)|who are you|what can you do|help)\b/.test(t) && t.split(/\s+/).length <= 6) return true;
  return false;
}
