import { describe, expect, it } from 'vitest';
import { isSmallTalk, parseAgentText, parseInline } from './agentText';

describe('canvas agent text', () => {
  it('parses the agent Markdown subset into text blocks', () => {
    expect(parseInline('Use **Seedance** or `auto`.')).toEqual([{ text: 'Use ' }, { text: 'Seedance', bold: true }, { text: ' or ' }, { text: 'auto', code: true }, { text: '.' }]);
    const blocks = parseAgentText('I plan and edit.\n\n- **Shot plans**: options\n- Canvas\n\n1. First\n2. Second\nDone <b>x</b>');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'ol', 'p']);
    expect(blocks[1]).toEqual({ type: 'ul', items: [[{ text: 'Shot plans', bold: true }, { text: ': options' }], [{ text: 'Canvas' }]] });
    // Never HTML: tags stay text.
    expect(blocks[3]).toEqual({ type: 'p', parts: [{ text: 'Done <b>x</b>' }] });
    expect(parseAgentText('## Title\nline')).toEqual([{ type: 'p', parts: [{ text: 'Title\nline' }] }]);
  });

  it('mock small talk: greetings, not briefs', () => {
    expect(isSmallTalk('hello')).toBe(true);
    expect(isSmallTalk('Thanks!')).toBe(true);
    expect(isSmallTalk('A 15-second vertical ad for sparkling water')).toBe(false);
    expect(isSmallTalk('hello, make me a 30 second video for my bakery with three shots and voiceover')).toBe(false);
  });
});
