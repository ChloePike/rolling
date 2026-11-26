import { describe, expect, it } from 'vitest';
import type { Proposal } from '@/features/overlays/agent';
import { isSmallTalk, messagesFromThread, openPlanId, parseAgentText, parseInline, toolLabelKey } from './thread';

const plan = (id: string, status: Proposal['status']): Proposal =>
  ({ id, kind: 'plan', status, baseRevision: null, summary: '', createdAt: 0, estimate: { credits: 0 }, risks: [], body: { kind: 'plan', seconds: 15, refs: [], options: [] } }) as unknown as Proposal;

describe('home agent thread', () => {
  it('restores messages with the proposals they made', () => {
    const msgs = messagesFromThread({
      messages: [
        { id: 'm1', role: 'user', content: 'A 15s ad', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'Two options.', createdAt: 2, proposalId: 'p1' },
      ],
      proposals: [plan('p1', 'proposed')],
    });
    expect(msgs.map((m) => [m.role, m.text, m.proposal?.id ?? null])).toEqual([
      ['user', 'A 15s ad', null],
      ['agent', 'Two options.', 'p1'],
    ]);
    expect(openPlanId(msgs)).toBe('p1');
  });

  it('only the newest plan is open', () => {
    const msgs = messagesFromThread({
      messages: [
        { id: 'a', role: 'assistant', content: '', createdAt: 1, proposalId: 'p1' },
        { id: 'b', role: 'assistant', content: '', createdAt: 2, proposalId: 'p2' },
      ],
      proposals: [plan('p1', 'proposed'), plan('p2', 'applied')],
    });
    expect(openPlanId(msgs)).toBeNull();
  });

  it('parses the agent Markdown subset into text blocks', () => {
    expect(parseInline('Use **Seedance** or `auto`.')).toEqual([{ text: 'Use ' }, { text: 'Seedance', bold: true }, { text: ' or ' }, { text: 'auto', code: true }, { text: '.' }]);
    const blocks = parseAgentText('I plan and edit.\n\n- **Shot plans**: options\n- Canvas\n\n1. First\n2. Second\nDone <b>x</b>');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'ol', 'p']);
    expect(blocks[1]).toEqual({ type: 'ul', items: [[{ text: 'Shot plans', bold: true }, { text: ': options' }], [{ text: 'Canvas' }]] });
    // Never HTML: tags stay text.
    expect(blocks[3]).toEqual({ type: 'p', parts: [{ text: 'Done <b>x</b>' }] });
    expect(parseAgentText('## Title\nline')).toEqual([{ type: 'p', parts: [{ text: 'Title\nline' }] }]);
  });

  it('names the running read tool', () => {
    expect(toolLabelKey('models.capabilities')).toBe('models');
    expect(toolLabelKey('propose.plan')).toBe('proposal');
    expect(toolLabelKey(null)).toBeNull();
  });

  it('mock small talk: greetings, not briefs', () => {
    expect(isSmallTalk('hello')).toBe(true);
    expect(isSmallTalk('Thanks!')).toBe(true);
    expect(isSmallTalk('A 15-second vertical ad for sparkling water')).toBe(false);
    expect(isSmallTalk('hello, make me a 30 second video for my bakery with three shots and voiceover')).toBe(false);
  });
});
