import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import type { ChatEvent, ChatRequest, LlmProvider } from '../models/types';
import { MARKUP, QUALITY_REVIEW, USD_PER_CREDIT, reviewMaxUsd } from '../pricing/config';
import {
  buildReview,
  decideRetry,
  fixParams,
  gradeOf,
  needsRetry,
  overallScore,
  pickCurrent,
  rankTakes,
  ratioIssue,
  summarizeReview,
  takeVerdict,
  type RetryContext,
} from './decide';
import { ReviewError, reviewMessages, reviewOutputs, reviewPlan, type ReviewInput } from './review';
import { parseReviewAnswer, type ReviewScores, type TakeVerdict } from './types';

const chatModels = fixtureCatalog.list({ kind: 'chat', includeMatureOnly: true });

const ALL5: ReviewScores = { anatomy: 5, text: 5, adherence: 5, continuity: null, framing: 5, artifacts: 5 };

function take(scores: Partial<ReviewScores>, issues: TakeVerdict['issues'] = [], fix: TakeVerdict['fix'] = null): TakeVerdict {
  return takeVerdict({ scores: { ...ALL5, ...scores }, issues, fix });
}

const HANDS = take({ anatomy: 2 }, [{ dimension: 'anatomy', severity: 'major', note: 'Left hand has six fingers' }], {
  prompt: 'A chef plating pasta, hands relaxed, five fingers on each hand',
  negativePrompt: 'extra fingers, fused fingers',
  note: 'Asks for natural hands',
});

const ctx = (over: Partial<RetryContext> = {}): RetryContext => ({ mode: 'edit', isRetry: false, nodeRetried: false, retryCredits: 40, budgetLeft: 300, hasNode: true, ...over });

describe('verdict parsing', () => {
  it('parses a full answer, coerces string scores and drops unknown issue dimensions', () => {
    const text = JSON.stringify({
      takes: [
        {
          scores: { anatomy: '2', text: 5, adherence: 4, continuity: null, framing: 4, artifacts: 4.6 },
          issues: [
            { dimension: 'anatomy', severity: 'major', note: '  Left hand   has six fingers ' },
            { dimension: 'vibes', severity: 'minor', note: 'Not a dimension' },
            { dimension: 'text', severity: 'catastrophic', note: 'Garbled sign' },
          ],
          fix: { prompt: 'Same, five fingers', negativePrompt: 'extra fingers', note: 'Fix hands' },
        },
      ],
    });
    const [t] = parseReviewAnswer(text, 1, overallScore);
    expect(t!.scores).toEqual({ anatomy: 2, text: 5, adherence: 4, continuity: null, framing: 4, artifacts: 5 });
    expect(t!.issues).toEqual([
      { dimension: 'anatomy', severity: 'major', note: 'Left hand has six fingers' },
      { dimension: 'text', severity: 'minor', note: 'Garbled sign' },
    ]);
    expect(t!.fix).toEqual({ prompt: 'Same, five fingers', negativePrompt: 'extra fingers', note: 'Fix hands' });
  });

  it('accepts code fences, a bare take and a fix without a note; drops an empty fix', () => {
    const fenced = '```json\n{"scores":{"anatomy":4,"text":5,"adherence":3,"framing":5,"artifacts":5},"issues":[{"dimension":"adherence","severity":"minor","note":"One dog, not two"}],"fix":{"prompt":"Two dogs"}}\n```';
    const [t] = parseReviewAnswer(fenced, 1, overallScore);
    expect(t!.scores.continuity).toBeNull();
    expect(t!.fix).toEqual({ prompt: 'Two dogs', note: 'One dog, not two' });
    const [u] = parseReviewAnswer('{"takes":[{"scores":{"anatomy":5},"issues":[],"fix":{"note":"nothing"}}]}', 1, overallScore);
    expect(u!.fix).toBeNull();
  });

  it('refuses non-JSON, out-of-range scores and the wrong take count', () => {
    expect(() => parseReviewAnswer('looks great', 1, overallScore)).toThrow(/not JSON/);
    expect(() => parseReviewAnswer('{"takes":[{"scores":{"anatomy":9}}]}', 1, overallScore)).toThrow(/validation/);
    expect(() => parseReviewAnswer('{"takes":[{"scores":{}}]}', 2, overallScore)).toThrow(/1 of 2/);
  });
});

describe('scoring and ranking', () => {
  it('weighs the worst dimension and caps majors below fair', () => {
    expect(overallScore(ALL5)).toBe(5);
    expect(overallScore({ ...ALL5, anatomy: 1 })).toBe(2.6);
    expect(overallScore({ ...ALL5, text: 4 }, [{ severity: 'major' }])).toBe(2.5);
    expect(overallScore({ anatomy: null, text: null, adherence: null, continuity: null, framing: null, artifacts: null })).toBe(3);
    expect([gradeOf(4.2), gradeOf(3), gradeOf(2.9)]).toEqual(['good', 'fair', 'poor']);
  });

  it('needs a retry at a 2 or a major issue', () => {
    expect(needsRetry(take({}))).toBe(false);
    expect(needsRetry(take({ adherence: 3 }))).toBe(false);
    expect(needsRetry(HANDS)).toBe(true);
    expect(needsRetry(take({}, [{ dimension: 'text', severity: 'major', note: 'Logo' }]))).toBe(true);
  });

  it('ranks takes best first and preselects the best', () => {
    const a = take({ adherence: 3 });
    const b = take({});
    const c = take({ adherence: 3 }, [{ dimension: 'adherence', severity: 'major', note: 'x' }]);
    const d = take({ anatomy: 4, artifacts: 4 });
    expect(rankTakes([a, b, c, d])).toEqual([1, 3, 0, 2]);
    const r = buildReview({ model: 'm', costUsd: 0.001, takes: [a, b, c, d] });
    expect(r.best).toBe(1);
    expect(r.grade).toBe('good');
    // Ties keep output order.
    expect(rankTakes([b, b])).toEqual([0, 1]);
  });
});

describe('retry decision', () => {
  const bad = buildReview({ model: 'm', costUsd: null, takes: [HANDS] });
  const good = buildReview({ model: 'm', costUsd: null, takes: [take({})] });

  it('does nothing for a good take, a take without a fix or an output without a node', () => {
    expect(decideRetry(good, ctx({ mode: 'auto' }))).toEqual({ kind: 'none' });
    expect(decideRetry({ ...bad, fix: null }, ctx({ mode: 'auto' }))).toEqual({ kind: 'none' });
    expect(decideRetry(bad, ctx({ hasNode: false }))).toEqual({ kind: 'none' });
  });

  it('offers in Read and Edit mode; Auto retries once within the budget', () => {
    expect(decideRetry(bad, ctx({ mode: 'edit' }))).toEqual({ kind: 'offer', reason: 'manual' });
    expect(decideRetry(bad, ctx({ mode: 'read' }))).toEqual({ kind: 'offer', reason: 'manual' });
    expect(decideRetry(bad, ctx({ mode: 'auto' }))).toEqual({ kind: 'auto', runId: null });
    expect(decideRetry(bad, ctx({ mode: 'auto', retryCredits: 300, budgetLeft: 300 }))).toEqual({ kind: 'auto', runId: null });
    expect(decideRetry(bad, ctx({ mode: 'auto', retryCredits: 301, budgetLeft: 300 }))).toEqual({ kind: 'offer', reason: 'budget' });
    expect(decideRetry(bad, ctx({ mode: 'auto', budgetLeft: null }))).toEqual({ kind: 'offer', reason: 'budget' });
    expect(decideRetry(bad, ctx({ mode: 'auto', nodeRetried: true }))).toEqual({ kind: 'offer', reason: 'retried' });
    expect(decideRetry(bad, ctx({ mode: 'auto', isRetry: true }))).toEqual({ kind: 'offer', reason: 'retried' });
  });

  it('keeps the better version current after a retry (ties go to the retry)', () => {
    expect(pickCurrent(bad, good)).toBe('retry');
    expect(pickCurrent(good, bad)).toBe('original');
    expect(pickCurrent(bad, bad)).toBe('retry');
    expect(pickCurrent(bad, null)).toBe('original');
    expect(pickCurrent(null, bad)).toBe('retry');
    const capped = (scores: Partial<ReviewScores>) => buildReview({ model: 'm', costUsd: null, takes: [take(scores, [{ dimension: 'anatomy', severity: 'major', note: 'x' }])] });
    // Both capped at 2.5 by a major issue: the worst dimension decides.
    expect(pickCurrent(capped({ adherence: 2 }), capped({ anatomy: 1 }))).toBe('original');
    expect(pickCurrent(capped({ anatomy: 1 }), capped({ adherence: 2 }))).toBe('retry');
  });

  it('summarizes for the node chip', () => {
    const s = summarizeReview({ ...bad, action: { kind: 'offer', reason: 'manual' } });
    expect(s).toMatchObject({ grade: 'poor', offer: true, autoRetried: false, takes: 1, best: 0 });
    expect(s.issues[0]!.note).toBe('Left hand has six fingers');
  });
});

describe('fix params', () => {
  it('writes the prompt, appends new negative terms and keeps the rest', () => {
    const out = fixParams({ prompt: 'A chef plating pasta', negativePrompt: 'blur, Extra Fingers', seed: 7 }, HANDS.fix!);
    expect(out).toEqual({ prompt: HANDS.fix!.prompt, negativePrompt: 'blur, Extra Fingers, fused fingers' });
  });
  it('asks for a fresh seed when only luck is at fault', () => {
    expect(fixParams({ prompt: 'x' }, { newSeed: true, note: 'Try again' }, () => 0.5)).toEqual({ seed: 1_073_741_823 });
    expect(fixParams({ prompt: 'x' }, { prompt: 'x', note: 'Same' }, () => 0)).toEqual({ seed: 0 });
  });
});

describe('ratio check', () => {
  it('flags a size that does not match the declared ratio', () => {
    expect(ratioIssue('16:9', 1920, 1080)).toBeNull();
    expect(ratioIssue('9:16', 1024, 1024)).toMatchObject({ dimension: 'framing', severity: 'major' });
    expect(ratioIssue(undefined, 10, 10)).toBeNull();
  });
});

function fakeLlm(answer: string | Error, costUsd = 0.0009) {
  const calls: ChatRequest[] = [];
  const llm: LlmProvider = {
    id: 'fake',
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      calls.push(req);
      if (answer instanceof Error) {
        yield { type: 'error', error: { code: answer.message, message: answer.message, retryable: true } };
        return;
      }
      yield { type: 'text', delta: answer };
      yield { type: 'usage', usage: { promptTokens: 3000, completionTokens: 300, totalTokens: 3300, cachedTokens: 0, costUsd } };
      yield { type: 'done', id: 'x', finishReason: 'stop' };
    },
  };
  return { llm, calls };
}

const INPUT: ReviewInput = {
  kind: 'video',
  prompt: 'Mara, a woman with short silver hair in a red coat, walks through a night market',
  ratio: '9:16',
  seconds: 5,
  count: 2,
  characters: [{ name: 'Mara', look: 'short silver hair', wardrobe: 'red coat' }],
  references: [{ label: 'Character: Mara', url: 'data:image/jpeg;base64,AAA' }],
  takes: [{ pictures: ['data:image/jpeg;base64,T1A', 'data:image/jpeg;base64,T1B'] }, { pictures: ['data:image/jpeg;base64,T2A', 'data:image/jpeg;base64,T2B'] }],
};

describe('review call', () => {
  it('sends the brief, the reference and every frame in order, and ranks the takes', async () => {
    const answer = JSON.stringify({
      takes: [
        { scores: { anatomy: 4, text: 5, adherence: 4, continuity: 2, framing: 4, artifacts: 4 }, issues: [{ dimension: 'continuity', severity: 'major', note: 'Coat is blue, not red' }], fix: { prompt: 'Mara in a red coat', note: 'Restates the red coat' } },
        { scores: { anatomy: 5, text: 5, adherence: 5, continuity: 5, framing: 4, artifacts: 4 }, issues: [], fix: null },
      ],
    });
    const { llm, calls } = fakeLlm(answer);
    const r = await reviewOutputs(llm, chatModels, INPUT, 'job_1.review');
    expect(r.best).toBe(1);
    expect(r.takes[0]!.grade).toBe('poor');
    expect(r.costUsd).toBe(0.0009);
    const req = calls[0]!;
    expect(req.model).toBe(reviewPlan(chatModels, INPUT).models[0]);
    expect(req.idempotencyKey).toBe('job_1.review');
    expect(req.responseFormat).toEqual({ type: 'json_object' });
    const user = req.messages[1]!.content as { type: string; text?: string; imageUrl?: string }[];
    expect(user.filter((p) => p.type === 'image_url').map((p) => p.imageUrl)).toEqual(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,T1A', 'data:image/jpeg;base64,T1B', 'data:image/jpeg;base64,T2A', 'data:image/jpeg;base64,T2B']);
    expect(user[0]!.text).toContain('"takes_asked":2');
    expect(user[0]!.text).toContain('red coat');
  });

  it('drops continuity when nothing was declared and folds in the ratio check', async () => {
    const answer = '{"takes":[{"scores":{"anatomy":5,"text":5,"adherence":5,"continuity":1,"framing":5,"artifacts":5},"issues":[{"dimension":"continuity","severity":"major","note":"Different person"}],"fix":null}]}';
    const { llm } = fakeLlm(answer);
    const r = await reviewOutputs(llm, chatModels, { ...INPUT, kind: 'image', count: 1, characters: [], references: [], takes: [{ pictures: ['data:x'], width: 1024, height: 1024 }] }, 'k');
    expect(r.takes[0]!.scores.continuity).toBeNull();
    expect(r.issues).toEqual([{ dimension: 'framing', severity: 'major', note: 'Output is 1024×1024, not 9:16' }]);
    expect(r.grade).toBe('poor');
  });

  it('fails with a review error (never a job failure) on bad answers and gateway errors', async () => {
    await expect(reviewOutputs(fakeLlm('nope').llm, chatModels, INPUT, 'k')).rejects.toMatchObject({ code: 'invalid' });
    await expect(reviewOutputs(fakeLlm(new Error('upstream_error')).llm, chatModels, INPUT, 'k')).rejects.toBeInstanceOf(ReviewError);
    await expect(reviewOutputs(fakeLlm('{}').llm, chatModels, { ...INPUT, takes: [{ pictures: [] }] }, 'k')).rejects.toMatchObject({ code: 'no_pictures' });
    await expect(reviewOutputs(fakeLlm('{}').llm, [], INPUT, 'k')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('caps pictures per take and the number of takes', () => {
    const many = { ...INPUT, takes: Array.from({ length: 6 }, () => ({ pictures: ['a', 'b', 'c'] })) };
    const { parts } = reviewMessages(many);
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(QUALITY_REVIEW.maxReferences - 1 + QUALITY_REVIEW.maxTakes * QUALITY_REVIEW.maxPicturesPerTake);
  });
});

describe('review cost (D-024: covered from the margin)', () => {
  it('stays within the per-output cap on the cheapest review model', () => {
    const { maxUsd } = reviewPlan(chatModels, INPUT);
    expect(maxUsd / INPUT.takes.length).toBeLessThanOrEqual(QUALITY_REVIEW.maxUsdPerOutput);
  });
  it('is smaller than the margin of the cheapest output (one credit)', () => {
    const minMarginPerOutput = USD_PER_CREDIT * (1 - 1 / MARKUP);
    expect(QUALITY_REVIEW.maxUsdPerOutput).toBeLessThan(minMarginPerOutput);
    expect(QUALITY_REVIEW.expectedUsdPerOutput).toBeLessThanOrEqual(QUALITY_REVIEW.maxUsdPerOutput);
    // DeepSeek V4.1 Flash US route list prices, two frames and one reference.
    expect(reviewMaxUsd(1, 2, 1, { prompt: 0.075e-6, completion: 0.3e-6 })).toBeLessThan(QUALITY_REVIEW.expectedUsdPerOutput);
  });
});
