import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureModel } from '../models/__fixtures__/catalog';
import type { ChatEvent, ChatRequest, LlmProvider } from '../models/types';
import { detectUploadFaces, isMatureRating, postCheck, preCheck, quickCheck, rateMedia, type SafetyDeps } from './check';
import { createSafetyGate } from './gate';
import { FACE_DETECT_MODEL, faceBoxOf, faceResultOf, visionModelsFor, type ImageAssessment, type TextAssessment } from './llm';
import { HARD_LIMIT_CODES, type VerdictCache } from './types';

const chatModels = fixtureCatalog.list({ kind: 'chat', includeMatureOnly: true });

const SAFE_TEXT: TextAssessment = {
  sexualLevel: 'none',
  apparentMinor: false,
  minorSexualized: false,
  realPerson: false,
  realPersonNames: [],
  realPersonSexualOrIntimate: false,
  nonConsensualSexual: false,
  animalSexual: false,
  extremeViolence: false,
  violentExtremism: false,
  selfHarm: false,
};

const SAFE_IMAGE: ImageAssessment = {
  rating: 'safe',
  confidence: 0.9,
  photographic: false,
  apparentMinor: false,
  minorSexualized: false,
  knownPerson: false,
  animalSexual: false,
  extremeViolence: false,
  violentExtremism: false,
  selfHarm: false,
};

type Answer = string | Error | 'hang';

/** Fake chat adapter: answers by request kind (text classifier, vision, face-detect). */
function fakeLlm(answers: { text?: Answer; vision?: Answer | ((n: number) => Answer); faces?: Answer }) {
  const calls: ChatRequest[] = [];
  const llm: LlmProvider = {
    id: 'fake',
    async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
      calls.push(req);
      const user = req.messages.find((m) => m.role === 'user')!;
      const images = typeof user.content === 'string' ? 0 : user.content.filter((p) => p.type === 'image_url').length;
      let a: Answer | undefined;
      if (req.model === FACE_DETECT_MODEL) a = answers.faces;
      else if (images > 0) a = typeof answers.vision === 'function' ? answers.vision(images) : answers.vision;
      else a = answers.text;
      if (a === undefined) a = '{}';
      if (a === 'hang') {
        await new Promise((resolve) => {
          req.signal?.addEventListener('abort', resolve);
        });
        throw new Error('aborted');
      }
      if (a instanceof Error) {
        yield { type: 'error', error: { code: a.message, message: a.message, retryable: true } };
        return;
      }
      yield { type: 'text', delta: a };
      yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 0, costUsd: 0.0001 } };
      yield { type: 'done', id: 'x', finishReason: 'stop' };
    },
  };
  return { llm, calls };
}

let k = 0;
function deps(llm: LlmProvider | null, cache?: VerdictCache): SafetyDeps {
  return { llm, chatModels, newKey: () => `k${++k}`, textTimeoutMs: 50, visionTimeoutMs: 50, ...(cache && { cache }) };
}

function memoryCache(): VerdictCache & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (key) => map.get(key) ?? null, put: async (key, v) => void map.set(key, v) };
}

const text = (a: Partial<TextAssessment>) => JSON.stringify({ ...SAFE_TEXT, ...a });
const vision = (...a: Partial<ImageAssessment>[]) => JSON.stringify({ images: a.map((x) => ({ ...SAFE_IMAGE, ...x })) });

describe('preCheck: text classifier', () => {
  it('allows a benign prompt with a valid answer and uses DeepSeek V4.1 Flash', async () => {
    const f = fakeLlm({ text: text({}) });
    const v = await preCheck({ prompt: 'a child playing football in a park', references: [], mature: false }, deps(f.llm));
    expect(v.verdict).toBe('allow');
    expect(f.calls[0]!.model).toMatch(/^deepseek\/deepseek-v4\.1-flash/);
    expect(f.calls[0]!.responseFormat).toEqual({ type: 'json_object' });
    expect(v.checks.find((c) => c.name === 'text')).toMatchObject({ status: 'pass', costUsd: 0.0001 });
  });

  it.each<[string, Partial<TextAssessment>, string]>([
    ['minor sexualized', { minorSexualized: true, apparentMinor: true, sexualLevel: 'suggestive' }, 'MINOR_SEXUAL'],
    ['real person intimate', { realPerson: true, realPersonNames: ['A Celebrity'], realPersonSexualOrIntimate: true, sexualLevel: 'suggestive' }, 'REAL_PERSON_SEXUAL'],
    ['non-consensual', { nonConsensualSexual: true, sexualLevel: 'explicit' }, 'NON_CONSENSUAL'],
    ['sexual content involving an animal', { animalSexual: true, sexualLevel: 'explicit' }, 'ANIMAL_SEXUAL'],
    ['gore', { extremeViolence: true }, 'EXTREME_VIOLENCE'],
    ['extremism', { violentExtremism: true }, 'VIOLENT_EXTREMISM'],
    ['self-harm', { selfHarm: true }, 'SELF_HARM'],
  ])('blocks %s on mature and non-mature runs', async (_n, a, code) => {
    for (const mature of [true, false]) {
      const v = await preCheck({ prompt: 'category test', references: [], mature }, deps(fakeLlm({ text: text(a) }).llm));
      expect(v.verdict).toBe('block');
      expect(v.reasons.map((r) => r.code)).toContain(code);
    }
  });

  it('allows real-person references for non-sexual content', async () => {
    const v = await preCheck({ prompt: 'a famous chef cooking pasta', references: [], mature: false }, deps(fakeLlm({ text: text({ realPerson: true, realPersonNames: ['Chef'] }) }).llm));
    expect(v.verdict).toBe('allow');
  });

  it('asks for mature content when a non-mature prompt is explicit (MATURE_REQUIRED), allows it on mature runs', async () => {
    const f = fakeLlm({ text: text({ sexualLevel: 'explicit' }) });
    expect((await preCheck({ prompt: 'adult category', references: [], mature: false }, deps(f.llm))).reasons.map((r) => r.code)).toEqual(['MATURE_REQUIRED']);
    expect((await preCheck({ prompt: 'adult category', references: [], mature: true }, deps(f.llm))).verdict).toBe('allow');
  });

  it('maps the classifier animalSexual flag to the ANIMAL_SEXUAL hard limit, even for a mature-allowed caller', async () => {
    const f = fakeLlm({ text: text({ animalSexual: true, sexualLevel: 'explicit' }) });
    const v = await preCheck({ prompt: 'an old man and his pet, adult category', references: [], mature: true, matureAllowed: true }, deps(f.llm));
    expect(v.verdict).toBe('block');
    expect(v.reasons.map((r) => r.code)).toEqual(['ANIMAL_SEXUAL']);
    expect(HARD_LIMIT_CODES.has('ANIMAL_SEXUAL')).toBe(true);
  });

  it('blocks the zh example by rules before any classifier call, even on a mature run', async () => {
    const f = fakeLlm({ text: text({}) });
    const v = await preCheck({ prompt: '我想看一个亚洲老头对着猫儿打飞机', references: [], mature: true, matureAllowed: true }, deps(f.llm));
    expect(v.reasons.map((r) => r.code)).toEqual(['ANIMAL_SEXUAL']);
    expect(f.calls).toHaveLength(0);
  });

  it('keeps pets in a non-sexual scene allowed (classifier says no)', async () => {
    const v = await preCheck({ prompt: 'an old man feeding his cat on a sunny porch', references: [], mature: false }, deps(fakeLlm({ text: text({}) }).llm));
    expect(v.verdict).toBe('allow');
  });

  it('D-005: a mature-allowed caller is never asked to turn mature content on; the run reports needsMature', async () => {
    const f = fakeLlm({ text: text({ sexualLevel: 'explicit' }) });
    const v = await preCheck({ prompt: 'adult category', references: [], mature: false, matureAllowed: true }, deps(f.llm));
    expect(v).toMatchObject({ verdict: 'allow', reasons: [], needsMature: true });
    const mature = await preCheck({ prompt: 'adult category', references: [], mature: true, matureAllowed: true }, deps(f.llm));
    expect(mature.verdict).toBe('allow');
    expect(mature.needsMature).toBeUndefined();
  });

  it('D-005: for a mature-allowed caller only hard limits block, at every stage', async () => {
    // Pre (text) on a mature run: explicit, suggestive, real person non-sexual → allow.
    for (const a of [{ sexualLevel: 'explicit' as const }, { sexualLevel: 'suggestive' as const }, { realPerson: true, realPersonNames: ['Chef'] }]) {
      const v = await preCheck({ prompt: 'adult category', references: [], mature: true, matureAllowed: true }, deps(fakeLlm({ text: text(a) }).llm));
      expect(v.verdict).toBe('allow');
    }
    // Vision on inputs: an explicit platform reference passes.
    const ref = { kind: 'image' as const, source: 'generated' as const, url: 'data:image/png;base64,AAAA', hash: 'h-explicit' };
    const withRef = await preCheck({ prompt: 'adult category', references: [ref], mature: true, matureAllowed: true }, deps(fakeLlm({ text: text({ sexualLevel: 'explicit' }), vision: vision({ rating: 'explicit' }) }).llm));
    expect(withRef.verdict).toBe('allow');
    // Post: explicit output of a non-mature run only rates.
    const post = await postCheck({ outputs: [{ kind: 'image', url: 'https://x/o.png' }], mature: false, matureAllowed: true, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'explicit' }) }).llm));
    expect(post).toMatchObject({ verdict: 'allow', reasons: [] });
    expect(post.rating?.rating).toBe('explicit');
    // Every code that still blocks is a hard limit or the fail-closed outage.
    const blocks = await Promise.all(
      [{ minorSexualized: true, apparentMinor: true }, { nonConsensualSexual: true }, { animalSexual: true }, { extremeViolence: true }, { violentExtremism: true }, { selfHarm: true }].map((a) =>
        preCheck({ prompt: 'adult category', references: [], mature: true, matureAllowed: true }, deps(fakeLlm({ text: text({ sexualLevel: 'explicit', ...a }) }).llm)),
      ),
    );
    for (const b of blocks) {
      expect(b.verdict).toBe('block');
      for (const r of b.reasons) expect(HARD_LIMIT_CODES.has(r.code) || r.code === 'SAFETY_UNAVAILABLE').toBe(true);
    }
  });

  it('blocks deterministic hits without calling the classifier', async () => {
    const f = fakeLlm({ text: text({}) });
    const v = await preCheck({ prompt: 'nude schoolgirl', references: [], mature: false }, deps(f.llm));
    expect(v.reasons[0]!.code).toBe('MINOR_SEXUAL');
    expect(f.calls).toHaveLength(0);
  });

  it.each<[string, Answer]>([
    ['garbage', 'not json at all'],
    ['wrong shape', JSON.stringify({ sexualLevel: 'very', apparentMinor: 'no' })],
    ['an error event', new Error('upstream_error')],
    ['a timeout', 'hang'],
  ])('fails closed on %s: mature blocks with SAFETY_UNAVAILABLE, non-mature allows and records the outage', async (_n, answer) => {
    const mature = await preCheck({ prompt: 'two adults', references: [], mature: true }, deps(fakeLlm({ text: answer }).llm));
    expect(mature.verdict).toBe('block');
    expect(mature.reasons.map((r) => r.code)).toEqual(['SAFETY_UNAVAILABLE']);
    const plain = await preCheck({ prompt: 'a lighthouse', references: [], mature: false }, deps(fakeLlm({ text: answer }).llm));
    expect(plain.verdict).toBe('allow');
    expect(plain.checks.find((c) => c.name === 'text')?.status).toBe('error');
  });

  it('fails closed without any LLM on mature runs', async () => {
    expect((await preCheck({ prompt: 'two adults', references: [], mature: true }, deps(null))).reasons[0]!.code).toBe('SAFETY_UNAVAILABLE');
    expect((await preCheck({ prompt: 'a lighthouse', references: [], mature: false }, deps(null))).verdict).toBe('allow');
  });

  it('accepts JSON in a code fence and caches assessments by content hash', async () => {
    const cache = memoryCache();
    const f = fakeLlm({ text: '```json\n' + text({}) + '\n```' });
    const d = deps(f.llm, cache);
    await preCheck({ prompt: 'a red bicycle', references: [], mature: false }, d);
    const again = await preCheck({ prompt: 'a red bicycle', references: [], mature: false }, d);
    expect(f.calls).toHaveLength(1);
    expect(again.checks.find((c) => c.name === 'text')?.cached).toBe(true);
  });
});

describe('preCheck: references on mature runs (vision + faces)', () => {
  const upload = { kind: 'image' as const, source: 'upload' as const, url: 'data:image/png;base64,AAAA', hash: 'h1' };
  const generated = { kind: 'image' as const, source: 'generated' as const, url: 'https://cdn/x.png', hash: 'h2' };

  it('blocks an uploaded photograph with a real face on a mature run', async () => {
    const f = fakeLlm({ text: text({ sexualLevel: 'explicit' }), vision: vision({ photographic: true }), faces: JSON.stringify({ faces: [{ confidence: 99.5 }] }) });
    const v = await preCheck({ prompt: 'adult scene', references: [upload], mature: true }, deps(f.llm));
    expect(v.reasons.map((r) => r.code)).toEqual(['REAL_PERSON_SEXUAL']);
    expect(f.calls.some((c) => c.model === FACE_DETECT_MODEL)).toBe(true);
  });

  it('allows an uploaded illustration and skips face detection for illustrations and platform assets', async () => {
    const f = fakeLlm({ text: text({ sexualLevel: 'explicit' }), vision: vision({ photographic: false }, {}), faces: JSON.stringify({ faces: [{ confidence: 99 }] }) });
    const v = await preCheck({ prompt: 'adult scene', references: [upload, generated], mature: true }, deps(f.llm));
    expect(v.verdict).toBe('allow');
    expect(f.calls.filter((c) => c.model === FACE_DETECT_MODEL)).toHaveLength(0);
    // Both images go in one batched vision request.
    expect(f.calls.filter((c) => c.model !== FACE_DETECT_MODEL && typeof (c.messages[1] as any).content !== 'string')).toHaveLength(1);
  });

  it('blocks a reference showing an apparent minor or a recognizable person on a mature run', async () => {
    const minor = await preCheck({ prompt: 'adult scene', references: [generated], mature: true }, deps(fakeLlm({ text: text({}), vision: vision({ apparentMinor: true }) }).llm));
    expect(minor.reasons.map((r) => r.code)).toContain('MINOR_SEXUAL');
    const celeb = await preCheck({ prompt: 'adult scene', references: [generated], mature: true }, deps(fakeLlm({ text: text({}), vision: vision({ knownPerson: true }) }).llm));
    expect(celeb.reasons.map((r) => r.code)).toContain('REAL_PERSON_SEXUAL');
  });

  it('fails closed when vision or face detection is unavailable on a mature run', async () => {
    const v1 = await preCheck({ prompt: 'adult scene', references: [generated], mature: true }, deps(fakeLlm({ text: text({}), vision: 'nope' }).llm));
    expect(v1.reasons.map((r) => r.code)).toEqual(['SAFETY_UNAVAILABLE']);
    const v2 = await preCheck({ prompt: 'adult scene', references: [upload], mature: true }, deps(fakeLlm({ text: text({}), vision: vision({ photographic: true }), faces: new Error('x') }).llm));
    expect(v2.reasons.map((r) => r.code)).toEqual(['SAFETY_UNAVAILABLE']);
    // Wrong number of rated images is invalid.
    const v3 = await preCheck({ prompt: 'adult scene', references: [generated, { ...generated, hash: 'h3' }], mature: true }, deps(fakeLlm({ text: text({}), vision: vision({}) }).llm));
    expect(v3.reasons.map((r) => r.code)).toEqual(['SAFETY_UNAVAILABLE']);
  });

  it('does not run vision on non-mature references (cost)', async () => {
    const f = fakeLlm({ text: text({}) });
    await preCheck({ prompt: 'a sunny street', references: [upload], mature: false }, deps(f.llm));
    expect(f.calls).toHaveLength(1);
  });

  it('blocks face/head swap on mature runs deterministically', async () => {
    const f = fakeLlm({ text: text({}) });
    const v = await preCheck({ prompt: 'swap', references: [generated], mature: true, model: fixtureModel('lumina/face-swap') }, deps(f.llm));
    expect(v.reasons[0]!.code).toBe('IDENTITY_SWAP_MATURE');
    expect(f.calls).toHaveLength(0);
  });
});

describe('postCheck and rateMedia', () => {
  it('rates image outputs and blocks hard limits', async () => {
    const ok = await postCheck({ outputs: [{ kind: 'image', url: 'https://o/1.png', hash: 'a' }], mature: true, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'explicit', confidence: 0.8 }) }).llm));
    expect(ok.verdict).toBe('allow');
    expect(ok.rating).toMatchObject({ rating: 'explicit', confidence: 0.8 });
    const bad = await postCheck({ outputs: [{ kind: 'image', url: 'https://o/1.png', hash: 'b' }], mature: true, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'suggestive', apparentMinor: true }) }).llm));
    expect(bad.reasons.map((r) => r.code)).toContain('MINOR_SEXUAL');
  });

  it('blocks explicit output on a non-mature run with MATURE_REQUIRED, rates suggestive output without blocking', async () => {
    const explicit = await postCheck({ outputs: [{ kind: 'image', url: 'https://o/2.png' }], mature: false, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'explicit' }) }).llm));
    expect(explicit.reasons.map((r) => r.code)).toEqual(['MATURE_REQUIRED']);
    const suggestive = await postCheck({ outputs: [{ kind: 'image', url: 'https://o/3.png' }], mature: false, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'suggestive' }) }).llm));
    expect(suggestive.verdict).toBe('allow');
    expect(isMatureRating(suggestive.rating!.rating)).toBe(true);
  });

  it('checks video frames in one batch, takes the highest rating, and skips videos without frames', async () => {
    const f = fakeLlm({ vision: (n) => vision(...Array.from({ length: n }, (_, i) => (i === 1 ? { rating: 'suggestive' as const } : {}))) });
    const v = await postCheck({ outputs: [{ kind: 'video', frames: ['f0', 'f1', 'f2'] }], mature: false, prompt: 'p' }, deps(f.llm));
    expect(f.calls).toHaveLength(1);
    expect(v.rating!.rating).toBe('suggestive');
    const none = await postCheck({ outputs: [{ kind: 'video' }], mature: true, prompt: 'p' }, deps(fakeLlm({}).llm));
    expect(none.verdict).toBe('allow');
    expect(none.rating).toBeNull();
    expect(none.checks[0]).toMatchObject({ name: 'vision', status: 'skipped' });
  });

  it('blocks outputs showing sexual content involving an animal (vision), whatever the run', async () => {
    for (const [mature, matureAllowed] of [[true, true], [false, true], [false, false]] as const) {
      const v = await postCheck({ outputs: [{ kind: 'image', url: `https://o/an-${mature}-${matureAllowed}.png` }], mature, matureAllowed, prompt: 'p' }, deps(fakeLlm({ vision: vision({ rating: 'explicit', animalSexual: true }) }).llm));
      expect(v.reasons.map((r) => r.code)).toContain('ANIMAL_SEXUAL');
    }
  });

  it('fails closed on mature outputs when vision is down; non-mature outputs pass unrated', async () => {
    expect((await postCheck({ outputs: [{ kind: 'image', url: 'u' }], mature: true, prompt: 'p' }, deps(fakeLlm({ vision: 'hang' }).llm))).reasons[0]!.code).toBe('SAFETY_UNAVAILABLE');
    const plain = await postCheck({ outputs: [{ kind: 'image', url: 'u' }], mature: false, prompt: 'p' }, deps(fakeLlm({ vision: 'hang' }).llm));
    expect(plain).toMatchObject({ verdict: 'allow', rating: null });
  });

  it('rateMedia rates an upload and caches by content hash', async () => {
    const cache = memoryCache();
    const f = fakeLlm({ vision: vision({ rating: 'suggestive', confidence: 0.7 }) });
    const r1 = await rateMedia({ kind: 'image', url: 'data:image/png;base64,AA', hash: 'up1', source: 'upload' }, deps(f.llm, cache));
    const r2 = await rateMedia({ kind: 'image', url: 'data:image/png;base64,AA', hash: 'up1', source: 'upload' }, deps(f.llm, cache));
    expect(r1.rating).toMatchObject({ rating: 'suggestive' });
    expect(r2.rating).toMatchObject({ rating: 'suggestive' });
    expect(f.calls).toHaveLength(1);
  });

  it('uses the cheapest vision model with the others as gateway fallbacks', () => {
    const models = visionModelsFor(chatModels);
    expect(models[0]).toMatch(/^deepseek\//);
    expect(models).toContain('anthropic/claude-haiku-5.5');
  });
});

describe('quickCheck and SafetyGate', () => {
  it('quickCheck is synchronous rules only and reports explicit terms', () => {
    const q = quickCheck({ prompt: 'nsfw scene between adults', references: [], mature: false });
    expect(q.verdict).toBe('allow');
    expect(q.explicit).not.toEqual([]);
  });

  it('gate checks briefs and every proposal prompt, and reports verdicts', async () => {
    const seen: string[] = [];
    const gate = createSafetyGate(deps(fakeLlm({ text: text({}) }).llm), (v, what) => void seen.push(`${what}:${v.verdict}`));
    expect((await gate.checkBrief({ text: 'a romantic dinner for two adults', mature: true })).verdict).toBe('allow');
    const p = await gate.checkProposal({ mature: true, prompts: [{ prompt: 'shot 1: candles' }, { prompt: 'shot 2: lewd schoolgirl' }] });
    expect(p.verdict).toBe('block');
    expect(p.reasons[0]!.code).toBe('MINOR_SEXUAL');
    expect(seen).toEqual(['brief:allow', 'proposal:block']);
  });

  it('gate uses only the free rules on non-mature turns and asks for mature content on explicit proposals', async () => {
    const f = fakeLlm({ text: text({}) });
    const gate = createSafetyGate(deps(f.llm));
    expect((await gate.checkBrief({ text: 'a product video for sneakers', mature: false })).verdict).toBe('allow');
    const p = await gate.checkProposal({ mature: false, prompts: [{ prompt: 'shot 1: an nsfw scene' }] });
    expect(p.reasons.map((r) => r.code)).toEqual(['MATURE_REQUIRED']);
    expect(f.calls).toHaveLength(0);
    // Mature (mature-allowed) turns: explicit proposals pass; only hard limits block.
    const adult = await createSafetyGate(deps(fakeLlm({ text: text({ sexualLevel: 'explicit' }) }).llm)).checkProposal({ mature: true, prompts: [{ prompt: 'shot 1: an nsfw scene between two adults' }] });
    expect(adult.verdict).toBe('allow');
    const animal = await createSafetyGate(deps(fakeLlm({ text: text({}) }).llm)).checkBrief({ text: 'make a clip of a man having sex with a dog', mature: true });
    expect(animal.reasons.map((r) => r.code)).toEqual(['ANIMAL_SEXUAL']);
    // Mature proposals: one classifier call for all prompts.
    await gate.checkProposal({ mature: true, prompts: [{ prompt: 'shot 1' }, { prompt: 'shot 2' }, { prompt: 'shot 3' }] });
    expect(f.calls).toHaveLength(1);
  });
});

describe('face metadata (upload processing, UP-4)', () => {
  const upload = { kind: 'image' as const, source: 'upload' as const, url: 'data:image/png;base64,AAAA', hash: 'hface' };

  it('parses count, best confidence, boxes and the apparent-minor flag from the face-detect answer', () => {
    expect(faceResultOf([])).toEqual({ faces: 0, maxConfidence: 0, apparentMinor: null });
    const r = faceResultOf([
      { confidence: 99.1, box: { x: 10, y: 20, width: 30, height: 40 }, age: 31 },
      { confidence: 80, bbox: [100, 50, 140, 110], age_range: { low: 12, high: 16 } },
    ]);
    expect(r).toEqual({
      faces: 2,
      maxConfidence: 99.1,
      boxes: [
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 100, y: 50, width: 40, height: 60 },
      ],
      apparentMinor: true,
    });
    expect(faceResultOf([{ confidence: 95, age: 40 }]).apparentMinor).toBe(false);
    expect(faceResultOf([{ confidence: 95, minor: true }]).apparentMinor).toBe(true);
    expect(faceBoxOf({ rect: { left: 1, top: 2, right: 11, bottom: 22 } })).toEqual({ x: 1, y: 2, width: 10, height: 20 });
    expect(faceBoxOf({})).toBeNull();
  });

  it('detectUploadFaces caches under the preCheck key and reports outages', async () => {
    const cache = memoryCache();
    const f = fakeLlm({ faces: JSON.stringify({ faces: [{ confidence: 97, box: { x: 0, y: 0, w: 5, h: 5 } }] }) });
    const d = deps(f.llm, cache);
    const out = await detectUploadFaces({ url: upload.url, hash: upload.hash }, d);
    expect(out).toMatchObject({ ok: true, cached: false, value: { faces: 1, maxConfidence: 97, boxes: [{ x: 0, y: 0, width: 5, height: 5 }] } });
    expect(cache.map.has('face:hface')).toBe(true);
    expect(await detectUploadFaces({ url: upload.url, hash: upload.hash }, d)).toMatchObject({ ok: true, cached: true });
    expect(f.calls).toHaveLength(1);
    expect(await detectUploadFaces({ url: upload.url, hash: 'other' }, deps(fakeLlm({ faces: new Error('down') }).llm))).toMatchObject({ ok: false });
    expect(await detectUploadFaces({ url: upload.url }, deps(null))).toEqual({ ok: false, note: 'unavailable' });
  });

  it('preCheck uses face metadata stored at upload instead of detecting again', async () => {
    const f = fakeLlm({ text: text({ sexualLevel: 'explicit' }), vision: vision({ photographic: true }) });
    const v = await preCheck({ prompt: 'adult scene', references: [{ ...upload, face: { faces: 1, maxConfidence: 99 } }], mature: true }, deps(f.llm));
    expect(v.reasons.map((r) => r.code)).toEqual(['REAL_PERSON_SEXUAL']);
    expect(f.calls.some((c) => c.model === FACE_DETECT_MODEL)).toBe(false);
    expect(v.checks.find((c) => c.name === 'faces')).toMatchObject({ status: 'pass', cached: true });
  });

  it('an apparent minor from face detection blocks mature runs and sexual uploads', async () => {
    const minorFace = { faces: 1, maxConfidence: 98, apparentMinor: true };
    const f = fakeLlm({ text: text({}), vision: vision({ photographic: false }) });
    const v = await preCheck({ prompt: 'adult scene', references: [{ ...upload, face: minorFace }], mature: true }, deps(f.llm));
    expect(v.reasons.map((r) => r.code)).toContain('MINOR_SEXUAL');
    const rated = await rateMedia({ kind: 'image', source: 'upload', url: upload.url, hash: 'hm', face: minorFace }, deps(fakeLlm({ vision: vision({ rating: 'suggestive' }) }).llm));
    expect(rated.reasons.map((r) => r.code)).toContain('MINOR_SEXUAL');
    const safe = await rateMedia({ kind: 'image', source: 'upload', url: upload.url, hash: 'hs', face: minorFace }, deps(fakeLlm({ vision: vision({}) }).llm));
    expect(safe.verdict).toBe('allow');
  });
});
