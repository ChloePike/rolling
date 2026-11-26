import type { Proposal, Thread } from '@/features/overlays/agent';

/**
 * Home agent conversation: message model and pure helpers (unit tested in
 * `thread.test.ts`). The hook is `useHomeThread.ts`, the view `HomeThread.tsx`.
 */

export interface ThreadMsg {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** Agent messages: streaming while the turn runs; error with a retry of `retryText`. */
  status: 'streaming' | 'done' | 'error';
  /** The read tool running right now (e.g. `models.capabilities`), while streaming. */
  tool?: string | null;
  /** The plan proposal this reply carries. */
  proposal?: Proposal | null;
  /** Error replies: what to send again. */
  retryText?: string;
  /** Error replies: what the retry needs (an allowance or rate limit cannot be retried at once). */
  retryable?: boolean;
}

/** Messages of a stored thread (`GET /api/agent/threads/:id`), proposals attached to the reply that made them. */
export function messagesFromThread(thread: Pick<Thread, 'messages' | 'proposals'>): ThreadMsg[] {
  const byId = new Map(thread.proposals.map((p) => [p.id, p]));
  return thread.messages.map((m) => ({
    id: m.id,
    role: m.role === 'user' ? 'user' : 'agent',
    text: m.content,
    status: 'done',
    ...(m.proposalId && byId.get(m.proposalId) ? { proposal: byId.get(m.proposalId)! } : {}),
  }));
}

/** The open plan proposal (the newest one still `proposed`); older ones read as replaced. */
export function openPlanId(messages: ThreadMsg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const p = messages[i]!.proposal;
    if (p && p.kind === 'plan') return p.status === 'proposed' ? p.id : null;
  }
  return null;
}

/** Human label key for a read tool the agent is running (`home.agent.tool.<key>`). */
export function toolLabelKey(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name.startsWith('models.')) return 'models';
  if (name.startsWith('pricing.')) return 'pricing';
  if (name.startsWith('assets.') || name.startsWith('characters.') || name.startsWith('voices.')) return 'assets';
  if (name.startsWith('templates.')) return 'templates';
  if (name.startsWith('account.')) return 'account';
  if (name.startsWith('propose.')) return 'proposal';
  return 'other';
}

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
