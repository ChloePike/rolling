/**
 * Consistency check (D-032): after a generation that used a character's
 * sheet, is it still the same face?
 *
 * Method, chosen from what the gateway offers (no embedding endpoint, no
 * face-recognition model in the catalog on 2026-11-27):
 * 1. `lumina/face-detect` with `crop_heads: true` on the output (an image, or
 *    a video's poster frame) and, once per sheet version, on its front view:
 *    the gateway returns a head crop per face ($0.0013 a picture, $0.0005 per
 *    extra face).
 * 2. The cheapest vision-capable chat model (DeepSeek V4.1 Flash, about
 *    $0.0001 a comparison) rates each candidate head against the reference
 *    head as strict JSON: a similarity from 0 to 1 for identity only.
 * 3. The best candidate's similarity is the drift score; below
 *    `DRIFT_THRESHOLDS.drift` the output is flagged.
 *
 * Pure parsing and the two gateway calls; storage and scheduling live in the
 * Worker (`apps/api/src/characters/consistency.ts`).
 */
import { z } from 'zod';
import type { ChatContentPart, ChatMessage, LlmProvider } from '../models/types';
import { FACE_DETECT_MODEL, faceBoxOf, parseJsonObject, SafetyLlmError, type FaceBox } from '../safety/llm';

/** Stored with every check so scores of different methods are never compared. */
export const CONSISTENCY_METHOD = 'face-detect+vision-v1';

/** Similarity at or above `consistent` reads as the same face; below `drift` is flagged. */
export const DRIFT_THRESHOLDS = { consistent: 0.75, drift: 0.55 } as const;

export type DriftVerdict = 'consistent' | 'minor' | 'drift' | 'no_face';

export function driftVerdict(score: number | null): DriftVerdict {
  if (score === null) return 'no_face';
  if (score >= DRIFT_THRESHOLDS.consistent) return 'consistent';
  if (score >= DRIFT_THRESHOLDS.drift) return 'minor';
  return 'drift';
}

/** At most this many faces of one output are compared (a crowd counts its largest faces). */
export const MAX_CANDIDATE_FACES = 4;
export const CONSISTENCY_TIMEOUT_MS = 20_000;

export interface HeadCrop {
  /** Head crop as the gateway returns it (https or data URL); null when only a box came back. */
  url: string | null;
  confidence: number;
  box?: FaceBox;
}

const FaceDetectAnswer = z.object({
  faces: z
    .array(z.object({ confidence: z.number().catch(0), head_url: z.string().optional().catch(undefined), headUrl: z.string().optional().catch(undefined) }).passthrough())
    .default([]),
});

/** Faces of a `crop_heads` face-detect answer, most confident first. */
export function headCropsOf(answer: unknown): HeadCrop[] {
  const parsed = FaceDetectAnswer.safeParse(answer);
  if (!parsed.success) throw new SafetyLlmError('invalid', 'face-detect answer failed validation');
  return parsed.data.faces
    .map((f) => {
      const box = faceBoxOf(f as Record<string, unknown>);
      const url = f.head_url ?? f.headUrl ?? null;
      return { url: url && /^(https:|data:image\/)/.test(url) ? url : null, confidence: f.confidence, ...(box && { box }) };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export const FaceMatchSchema = z.object({
  matches: z
    .array(
      z.object({
        image: z.number().int().min(2),
        similarity: z.number().min(0).max(1),
        sameIdentity: z.boolean(),
      }),
    )
    .min(1),
});
export type FaceMatch = z.infer<typeof FaceMatchSchema>;

export const FACE_MATCH_SYSTEM = [
  'You check identity consistency of a recurring character across generated pictures.',
  'Image 1 is the reference face of the character. Every later image is one face from a new picture.',
  'For each later image, rate how likely it shows the same character: face shape, eyes, brows, nose, mouth, skin tone, apparent age, hairline and hair color.',
  'Ignore expression, head angle, lighting, background, art style and image quality.',
  'similarity: 1 = clearly the same character, 0.7 = probably the same, 0.5 = similar type but likely another person, 0.2 or less = clearly someone else.',
  'Answer only strict JSON: {"matches":[{"image":2,"similarity":0.0,"sameIdentity":false}]} with one entry per later image.',
].join(' ');

export function faceMatchMessages(reference: string, candidates: readonly string[]): ChatMessage[] {
  const parts: ChatContentPart[] = [
    { type: 'text', text: `Image 1 is the reference. Images 2 to ${candidates.length + 1} are the faces to rate.` },
    { type: 'image_url', imageUrl: reference },
    ...candidates.map((u): ChatContentPart => ({ type: 'image_url', imageUrl: u })),
  ];
  return [
    { role: 'system', content: FACE_MATCH_SYSTEM },
    { role: 'user', content: parts },
  ];
}

/** The answer → the best candidate's similarity. */
export function bestMatch(answer: unknown, candidates: number): { score: number; image: number; sameIdentity: boolean } {
  const parsed = FaceMatchSchema.safeParse(answer);
  if (!parsed.success) throw new SafetyLlmError('invalid', `face match answer failed validation: ${parsed.error.issues[0]?.path.join('.')}`);
  const valid = parsed.data.matches.filter((m) => m.image >= 2 && m.image <= candidates + 1);
  if (valid.length === 0) throw new SafetyLlmError('invalid', 'face match answer names no candidate');
  const best = valid.reduce((a, b) => (b.similarity > a.similarity ? b : a));
  return { score: Math.round(best.similarity * 1000) / 1000, image: best.image, sameIdentity: best.sameIdentity };
}

async function collectText(
  llm: LlmProvider,
  req: { model: string; fallbackModels?: readonly string[]; messages: ChatMessage[]; maxTokens: number; key: string; json: boolean; extra?: Record<string, unknown> },
  timeoutMs: number,
): Promise<{ text: string; costUsd?: number }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafetyLlmError('timeout', `consistency check timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const run = (async () => {
    let text = '';
    let costUsd: number | undefined;
    for await (const ev of llm.chat({
      model: req.model,
      ...(req.fallbackModels?.length && { fallbackModels: req.fallbackModels.slice(0, 5) }),
      messages: req.messages,
      temperature: 0,
      maxTokens: req.maxTokens,
      ...(req.json && { responseFormat: { type: 'json_object' as const }, reasoningEffort: 'none' as const }),
      ...(req.extra && { extra: req.extra }),
      idempotencyKey: req.key,
      signal: controller.signal,
    })) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'usage' && ev.usage.costUsd !== null) costUsd = ev.usage.costUsd;
      else if (ev.type === 'error') throw new SafetyLlmError('upstream', ev.error.code);
    }
    return { text, ...(costUsd !== undefined && { costUsd }) };
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    run.catch(() => undefined);
  }
}

/** `lumina/face-detect` with head crops. */
export async function detectHeads(llm: LlmProvider, url: string, key: string, timeoutMs = CONSISTENCY_TIMEOUT_MS): Promise<{ heads: HeadCrop[]; costUsd?: number }> {
  const res = await collectText(
    llm,
    { model: FACE_DETECT_MODEL, messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: url }] }], maxTokens: 2048, key, json: false, extra: { crop_heads: true } },
    timeoutMs,
  );
  return { heads: headCropsOf(parseJsonObject(res.text)), ...(res.costUsd !== undefined && { costUsd: res.costUsd }) };
}

/** Rates candidate head crops against the reference head with a vision chat model. */
export async function compareFaces(
  llm: LlmProvider,
  models: readonly string[],
  reference: string,
  candidates: readonly string[],
  key: string,
  timeoutMs = CONSISTENCY_TIMEOUT_MS,
): Promise<{ score: number; sameIdentity: boolean; model: string; costUsd?: number }> {
  if (models.length === 0) throw new SafetyLlmError('unavailable', 'no vision-capable chat model is in the catalog');
  const list = candidates.slice(0, MAX_CANDIDATE_FACES);
  const res = await collectText(
    llm,
    { model: models[0]!, fallbackModels: models.slice(1), messages: faceMatchMessages(reference, list), maxTokens: 60 + 40 * list.length, key, json: true },
    timeoutMs,
  );
  const best = bestMatch(parseJsonObject(res.text), list.length);
  return { score: best.score, sameIdentity: best.sameIdentity, model: models[0]!, ...(res.costUsd !== undefined && { costUsd: res.costUsd }) };
}

/** Summary of the checks of one sheet version (the drift badge). */
export interface DriftSummary {
  checks: number;
  scored: number;
  /** Mean and lowest score of scored checks; null when none was scored. */
  mean: number | null;
  min: number | null;
  drifted: number;
  verdict: DriftVerdict | null;
}

export function summarizeDrift(scores: readonly (number | null)[]): DriftSummary {
  const scored = scores.filter((s): s is number => typeof s === 'number');
  const min = scored.length ? Math.min(...scored) : null;
  const mean = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 1000) / 1000 : null;
  return {
    checks: scores.length,
    scored: scored.length,
    mean,
    min,
    drifted: scored.filter((s) => driftVerdict(s) === 'drift').length,
    verdict: scores.length === 0 ? null : driftVerdict(min),
  };
}
