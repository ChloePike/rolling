import { describe, expect, it, vi } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import type { ChatEvent, ChatRequest, LlmProvider } from '../models/types';
import { AUTO_CLASSIFIER_TIMEOUT_MS, autoCandidates, chooseModel, llmClassifier, type Classify } from './auto';

const request = { kind: 'video' as const, mode: 't2v' as const, prompt: 'A cat on a skateboard', seconds: 5, resolution: '480p' };
const candidates = autoCandidates(fixtureCatalog, request, 'plus');

describe('autoCandidates', () => {
  it('keeps capable, listed, Auto-eligible models within the plan cap, cheapest first', () => {
    expect(candidates.length).toBeGreaterThan(2);
    for (const m of candidates) {
      expect(m.auto && !m.hidden && !m.requiresIdentitySafety && m.kind === 'video').toBe(true);
    }
    expect(candidates.map((m) => m.id)).toContain('bytedance/seedance-2.0-mini');
    // 2K MiniMax is above Plus for video; 768p is above Starter (D-006).
    const starter = autoCandidates(fixtureCatalog, { ...request, resolution: undefined }, 'starter').map((m) => m.id);
    expect(starter).not.toContain('minimax/minimax-h3');
  });
});

describe('chooseModel (D-009)', () => {
  const cheapest = candidates[0]!;

  it('uses a valid classifier answer', async () => {
    const pick = candidates[2]!;
    const r = await chooseModel({ request, candidates, classify: async () => ({ modelId: pick.id }) });
    expect(r).toMatchObject({ via: 'classifier' });
    expect(r!.model.id).toBe(pick.id);
    expect(r!.fallbacks.map((m) => m.id)).not.toContain(pick.id);
    expect(r!.fallbacks[0]!.id).toBe(cheapest.id);
  });

  it('accepts a JSON string answer', async () => {
    const r = await chooseModel({ request, candidates, classify: async () => JSON.stringify({ modelId: candidates[1]!.id }) });
    expect(r!.model.id).toBe(candidates[1]!.id);
  });

  it.each<[string, Classify]>([
    ['an id outside the candidates', async () => ({ modelId: 'openai/sora-9' })],
    ['garbage', async () => 'definitely not json {{'],
    ['a wrong shape', async () => ({ model: candidates[1]!.id })],
    ['null', async () => null],
  ])('falls back to the cheapest model on %s', async (_label, classify) => {
    const r = await chooseModel({ request, candidates, classify });
    expect(r).toMatchObject({ via: 'fallback', fallbackReason: 'invalid' });
    expect(r!.model.id).toBe(cheapest.id);
  });

  it('falls back on an error', async () => {
    const r = await chooseModel({ request, candidates, classify: async () => Promise.reject(new Error('upstream_error')) });
    expect(r).toMatchObject({ via: 'fallback', fallbackReason: 'error' });
  });

  it('falls back after the timeout and aborts the classifier', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const pending = chooseModel({
      request,
      candidates,
      classify: (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ modelId: candidates[1]!.id });
          });
        }),
    });
    await vi.advanceTimersByTimeAsync(AUTO_CLASSIFIER_TIMEOUT_MS);
    const r = await pending;
    vi.useRealTimers();
    expect(r).toMatchObject({ via: 'fallback', fallbackReason: 'timeout' });
    expect(r!.model.id).toBe(cheapest.id);
    expect(aborted).toBe(true);
  });

  it('returns null without candidates and skips the classifier for one', async () => {
    expect(await chooseModel({ request, candidates: [], classify: async () => ({}) })).toBeNull();
    const classify = vi.fn(async () => ({}));
    const r = await chooseModel({ request, candidates: [cheapest], classify });
    expect(r).toMatchObject({ via: 'single' });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('llmClassifier', () => {
  it('asks the cheapest DeepSeek V4.1 Flash route for JSON and returns its text', async () => {
    const seen: ChatRequest[] = [];
    const llm: LlmProvider = {
      id: 'fake',
      async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
        seen.push(req);
        yield { type: 'text', delta: '{"modelId": ' };
        yield { type: 'text', delta: `"${candidates[1]!.id}"}` };
        yield { type: 'done', id: 'c1', finishReason: 'stop' };
      },
    };
    const chatModels = [
      { id: 'deepseek/deepseek-v4.1-flash', price: [{ meter: 'prompt', conditions: {}, usd: 2e-7, minUnits: 0, unitStep: 1 }, { meter: 'completion', conditions: {}, usd: 4e-7, minUnits: 0, unitStep: 1 }] },
      { id: 'deepseek/deepseek-v4.1-flash-us', price: [{ meter: 'prompt', conditions: {}, usd: 1e-7, minUnits: 0, unitStep: 1 }, { meter: 'completion', conditions: {}, usd: 4e-7, minUnits: 0, unitStep: 1 }] },
    ];
    const classify = llmClassifier(llm, chatModels, () => 'idem-1');
    const r = await chooseModel({ request, candidates, classify });
    expect(r).toMatchObject({ via: 'classifier' });
    expect(r!.model.id).toBe(candidates[1]!.id);
    expect(seen[0]).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-us', responseFormat: { type: 'json_object' }, idempotencyKey: 'idem-1' });
    const user = JSON.parse(seen[0]!.messages[1]!.content as string);
    expect(user.candidates.map((c: { id: string }) => c.id)).toEqual(candidates.map((m) => m.id));
  });
});
