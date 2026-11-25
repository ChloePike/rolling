import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseListing } from './catalog';
import { availableChatModels, ChatModelUnavailableError, DEFAULT_CHAT_MODEL_ID, PUBLIC_CHAT_MODELS, resolveChatModel, tokenPrice } from './chat';

const listing = parseListing(JSON.parse(readFileSync(new URL('./__fixtures__/hyperouter-models.json', import.meta.url), 'utf8')));
const chat = listing.models.filter((m) => m.kind === 'chat');

describe('public chat models (D-009)', () => {
  it('offers the fixed public list with DeepSeek V4.1 Flash as default', () => {
    expect(PUBLIC_CHAT_MODELS.map((m) => m.name)).toEqual([
      'DeepSeek V4.1 Flash',
      'DeepSeek V4.1 Flash 1017',
      'Claude Sonnet 5.5',
      'Claude Haiku 5.5',
      'Claude Opus 5.5',
      'GPT-6 Astra',
      'GPT-6.1 Sol',
      'Grok 4.6',
      'GLM 5.3',
    ]);
    expect(DEFAULT_CHAT_MODEL_ID).toBe('deepseek-v4.1-flash');
  });

  it('reads token prices from the listing meters', () => {
    const us = chat.find((m) => m.id === 'deepseek/deepseek-v4.1-flash-us')!;
    expect(tokenPrice(us)).toEqual({ prompt: 7.5e-8, completion: 3e-7 });
  });

  it('routes to the cheapest available variant', () => {
    expect(resolveChatModel('deepseek-v4.1-flash', chat)).toBe('deepseek/deepseek-v4.1-flash-us');
    expect(resolveChatModel('deepseek-v4.1-flash-1017', chat)).toBe('deepseek/deepseek-v4.1-flash-1017');
    const withoutUs = chat.filter((m) => m.id !== 'deepseek/deepseek-v4.1-flash-us');
    expect(resolveChatModel('deepseek-v4.1-flash', withoutUs)).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('routes mature turns on 1017 to cyber, and only where a mature route exists', () => {
    expect(resolveChatModel('deepseek-v4.1-flash-1017', chat, { mature: true })).toBe('deepseek/deepseek-v4.1-flash-cyber');
    expect(resolveChatModel('deepseek-v4.1-flash', chat, { mature: true })).toBe('deepseek/deepseek-v4.1-flash-us');
    const noCyber = chat.filter((m) => m.id !== 'deepseek/deepseek-v4.1-flash-cyber');
    expect(resolveChatModel('deepseek-v4.1-flash-1017', noCyber, { mature: true })).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  it('hides entries with no available gateway model and refuses to resolve them', () => {
    const onlyDeepseek = chat.filter((m) => m.id.startsWith('deepseek/'));
    expect(availableChatModels(onlyDeepseek).map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);
    expect(() => resolveChatModel('claude-opus-5.5', onlyDeepseek)).toThrow(ChatModelUnavailableError);
    expect(() => resolveChatModel('nope', chat)).toThrow(ChatModelUnavailableError);
  });
});
