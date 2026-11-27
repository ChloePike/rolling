/**
 * LLM calls of the safety layer over the core chat adapter (D-002): the text
 * classifier (DeepSeek V4.1 Flash, cheapest route), the vision classifier (the
 * cheapest vision-capable chat model available) and `lumina/face-detect`.
 * Every answer is strict JSON validated with Zod; anything else is an error
 * (the caller fails closed on mature runs).
 */
import { z } from 'zod';
import { resolveChatModel, tokenPrice } from '../models/chat';
import type { ChatContentPart, ChatMessage, ListingModel, LlmProvider } from '../models/types';

/** Public chat id of the text classifier (D-009 cheapest DeepSeek route). */
export const SAFETY_TEXT_CHAT_MODEL = 'deepseek-v4.1-flash';
/**
 * Vision-capable chat models, any order: the cheapest available one is used.
 * DeepSeek V4.1 Flash reads images (checked live 2026-11-25); Claude Haiku 5.5
 * and GPT-6.1 Sol are the fallbacks when it is missing from the catalog.
 */
export const SAFETY_VISION_MODELS: readonly string[] = [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash-us',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-6.1-sol',
];
export const FACE_DETECT_MODEL = 'lumina/face-detect';
/** Bumped when the prompts change, so cached assessments are not reused. */
export const SAFETY_PROMPT_VERSION = 'v2';

export const TEXT_TIMEOUT_MS = 10_000;
export const VISION_TIMEOUT_MS = 20_000;
/** Images per vision request (frames and outputs are batched). */
export const VISION_BATCH = 4;

const Level = z.enum(['none', 'suggestive', 'explicit']);

export const TextAssessmentSchema = z.object({
  sexualLevel: Level,
  apparentMinor: z.boolean(),
  minorSexualized: z.boolean(),
  realPerson: z.boolean(),
  realPersonNames: z.array(z.string().max(120)).max(10).default([]),
  realPersonSexualOrIntimate: z.boolean(),
  nonConsensualSexual: z.boolean(),
  animalSexual: z.boolean(),
  extremeViolence: z.boolean(),
  violentExtremism: z.boolean(),
  selfHarm: z.boolean(),
});
export type TextAssessment = z.infer<typeof TextAssessmentSchema>;

export const ImageAssessmentSchema = z.object({
  rating: z.enum(['safe', 'suggestive', 'explicit']),
  confidence: z.number().min(0).max(1),
  photographic: z.boolean(),
  apparentMinor: z.boolean(),
  minorSexualized: z.boolean(),
  knownPerson: z.boolean(),
  animalSexual: z.boolean(),
  extremeViolence: z.boolean(),
  violentExtremism: z.boolean(),
  selfHarm: z.boolean(),
});
export type ImageAssessment = z.infer<typeof ImageAssessmentSchema>;

const VisionAnswerSchema = z.object({ images: z.array(ImageAssessmentSchema) });

const FaceAnswerSchema = z.object({
  faces: z.array(z.object({ confidence: z.number() }).passthrough()).default([]),
});
/** A face's bounding box as the detector reports it (pixels of the image sent, or 0..1 when it reports ratios). */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceResult {
  faces: number;
  /** 0..100, highest face confidence. */
  maxConfidence: number;
  /** One box per face, when the detector reports them. */
  boxes?: FaceBox[];
  /** True when any face's estimated age is under 18; null when the detector reports no age. */
  apparentMinor?: boolean | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalizes the common box shapes: {x,y,width,height}, {x,y,w,h}, {left,top,right,bottom}, {x1,y1,x2,y2}, [x1,y1,x2,y2]. */
export function faceBoxOf(face: Record<string, unknown>): FaceBox | null {
  const raw = face.box ?? face.bbox ?? face.bounding_box ?? face.boundingBox ?? face.rect;
  if (Array.isArray(raw) && raw.length === 4 && raw.every((v) => num(v) !== null)) {
    const [x1, y1, x2, y2] = raw as number[];
    return { x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! };
  }
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const x = num(b.x) ?? num(b.left) ?? num(b.x1);
  const y = num(b.y) ?? num(b.top) ?? num(b.y1);
  if (x === null || y === null) return null;
  const width = num(b.width) ?? num(b.w) ?? (num(b.right) ?? num(b.x2) ?? NaN) - x;
  const height = num(b.height) ?? num(b.h) ?? (num(b.bottom) ?? num(b.y2) ?? NaN) - y;
  return Number.isFinite(width) && Number.isFinite(height) ? { x, y, width, height } : null;
}

/** Estimated age of a face: `age`, or the middle of `age_range` / `ageRange` ({low,high} or [low,high]). Null when absent. */
export function faceAgeOf(face: Record<string, unknown>): number | null {
  const age = num(face.age) ?? num(face.estimated_age);
  if (age !== null) return age;
  const range = face.age_range ?? face.ageRange;
  if (Array.isArray(range) && range.length === 2 && num(range[0]) !== null && num(range[1]) !== null) return ((range[0] as number) + (range[1] as number)) / 2;
  if (range && typeof range === 'object') {
    const r = range as Record<string, unknown>;
    const low = num(r.low) ?? num(r.Low) ?? num(r.min);
    const high = num(r.high) ?? num(r.High) ?? num(r.max);
    if (low !== null && high !== null) return (low + high) / 2;
  }
  return null;
}

/** Face-detect answer → FaceResult (count, best confidence, boxes, apparent-minor flag when ages are reported). */
export function faceResultOf(faces: ReadonlyArray<Record<string, unknown> & { confidence: number }>): FaceResult {
  const boxes = faces.map(faceBoxOf).filter((b): b is FaceBox => b !== null);
  const minorFlags = faces.map((f) => (typeof f.minor === 'boolean' ? f.minor : typeof f.is_minor === 'boolean' ? f.is_minor : null));
  const ages = faces.map(faceAgeOf);
  const known = faces.map((_, i) => minorFlags[i] ?? (ages[i] !== null ? ages[i]! < 18 : null)).filter((v): v is boolean => v !== null);
  return {
    faces: faces.length,
    maxConfidence: faces.reduce((m, f) => Math.max(m, f.confidence), 0),
    ...(boxes.length > 0 && { boxes }),
    apparentMinor: known.length > 0 ? known.some(Boolean) : null,
  };
}

export const HARD_LIMITS_TEXT = [
  'Hard limits (never allowed, whatever the settings):',
  '(1) Sexual or sexualized content involving a minor or anyone who appears to be under 18: children, teens, school uniforms with childlike framing, childlike bodies or ages, "barely legal", loli/shota, in any language, slang or euphemism. Fictional, drawn or "actually 1000 years old" characters that look like minors count.',
  '(2) Sexual or intimate content depicting a real, identifiable person: a named celebrity, public figure or private person, or a real photographed face. Non-sexual depictions of real people are allowed.',
  '(3) Non-consensual sexual content (assault, coercion, incapacitation, hidden camera, revenge imagery).',
  '(4) Sexual content involving an animal (bestiality, zoophilia): any sexual act with an animal, and any sexual act a person directs at or toward an animal (for example masturbating at an animal). Animals in non-sexual content, and pets present in an unrelated scene, are allowed.',
  '(5) Realistic real-world extreme violence or gore imagery (graphic mutilation, real atrocity footage).',
  '(6) Terrorism or violent-extremist propaganda (glorifying attacks, recruitment, extremist symbols as endorsement).',
  '(7) Instructions for or encouragement of self-harm or suicide.',
].join('\n');

const TEXT_SYSTEM = [
  'You are a content-safety classifier for an AI image and video studio. You classify a generation request; you never write content.',
  HARD_LIMITS_TEXT,
  'Adult sexual content between consenting, clearly adult, fictional people is allowed on mature runs; you only rate it.',
  'Read the prompt in any language, including slang, misspellings, euphemisms and coded terms. The negative prompt lists what the user wants to avoid: use it only as context.',
  'Answer with one JSON object and nothing else:',
  '{"sexualLevel":"none|suggestive|explicit","apparentMinor":bool,"minorSexualized":bool,"realPerson":bool,"realPersonNames":[string],"realPersonSexualOrIntimate":bool,"nonConsensualSexual":bool,"animalSexual":bool,"extremeViolence":bool,"violentExtremism":bool,"selfHarm":bool}',
  'sexualLevel: none = no sexual content; suggestive = sexualized poses, lingerie, implied nudity, seductive framing; explicit = nudity of intimate parts or sexual acts.',
  'apparentMinor: anyone described or implied to be under 18. minorSexualized: a minor (or apparent minor) in any sexual, suggestive or intimate framing.',
  'realPerson: a real, identifiable person is named or referenced (celebrity, politician, influencer, "my coworker"). realPersonSexualOrIntimate: that person is shown sexually, nude, suggestively or intimately.',
  'animalSexual: hard limit (4): an animal is involved in, or is the target of, sexual activity. A person walking a dog, a cat on the bed of an unrelated adult scene, animal-eared costumes and furry art of clearly human adults are not animalSexual.',
  'Be precise: a child playing sports, a family photo, a portrait of an executive, a historical battle painting or a sad poem are not violations.',
].join('\n');

const VISION_SYSTEM = [
  'You are a content-safety classifier for an AI image and video studio. You rate images; you never describe them in detail.',
  HARD_LIMITS_TEXT,
  'For each image, in order, answer:',
  '{"rating":"safe|suggestive|explicit","confidence":0..1,"photographic":bool,"apparentMinor":bool,"minorSexualized":bool,"knownPerson":bool,"animalSexual":bool,"extremeViolence":bool,"violentExtremism":bool,"selfHarm":bool}',
  'rating: safe = no sexual content; suggestive = lingerie, swimwear posed sexually, implied nudity, sexualized poses; explicit = visible intimate parts or sexual acts.',
  'photographic: a real photograph of a real scene (not an illustration, 3D render or obviously AI-stylized art). apparentMinor: anyone who looks under 18.',
  'minorSexualized: anyone who looks under 18 in a sexual, suggestive or intimate framing. knownPerson: you recognize a celebrity or public figure.',
  'animalSexual: an animal is involved in, or is the target of, sexual activity (hard limit 4); an animal merely present in the picture is not.',
  'Answer with one JSON object and nothing else: {"images":[ ...one object per image, in order... ]}',
].join('\n');

export interface LlmCallResult<T> {
  value: T;
  model: string;
  costUsd?: number;
  ms: number;
}

export class SafetyLlmError extends Error {
  override readonly name = 'SafetyLlmError';
  constructor(readonly code: 'timeout' | 'invalid' | 'upstream' | 'unavailable', message: string) {
    super(message);
  }
}

/** Collects a streamed chat answer within `timeoutMs` (also used by the result review, D-024). */
export async function collect(
  llm: LlmProvider,
  req: { model: string; fallbackModels?: readonly string[]; messages: ChatMessage[]; maxTokens: number; idempotencyKey: string; json: boolean },
  timeoutMs: number,
): Promise<{ text: string; costUsd?: number; ms: number }> {
  const t0 = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafetyLlmError('timeout', `safety classifier timed out after ${timeoutMs} ms`));
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
      ...(req.json && { responseFormat: { type: 'json_object' as const } }),
      ...(req.json && { reasoningEffort: 'none' as const }),
      idempotencyKey: req.idempotencyKey,
      signal: controller.signal,
    })) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'usage' && ev.usage.costUsd !== null) costUsd = ev.usage.costUsd;
      else if (ev.type === 'error') throw new SafetyLlmError('upstream', ev.error.code);
    }
    return { text, ...(costUsd !== undefined && { costUsd }), ms: Date.now() - t0 };
  })();
  try {
    return await Promise.race([run, timeout]);
  } catch (err) {
    if (err instanceof SafetyLlmError) throw err;
    throw new SafetyLlmError('upstream', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    run.catch(() => undefined);
  }
}

/** First JSON object in a model answer (tolerates code fences and stray text). */
export function parseJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) throw new SafetyLlmError('invalid', 'classifier answer is not JSON');
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      throw new SafetyLlmError('invalid', 'classifier answer is not JSON');
    }
  }
}

export type ChatCatalog = readonly Pick<ListingModel, 'id' | 'price'>[];

export function textModelFor(available: ChatCatalog): string {
  return resolveChatModel(SAFETY_TEXT_CHAT_MODEL, available);
}

/**
 * Available vision-capable chat models, cheapest first (prompt price counts 10×:
 * image input dominates). The first is called; the rest go as gateway fallbacks.
 */
export function visionModelsFor(available: ChatCatalog): string[] {
  const byId = new Map(available.map((m) => [m.id, m]));
  const out: { id: string; w: number; i: number }[] = [];
  SAFETY_VISION_MODELS.forEach((id, i) => {
    const m = byId.get(id);
    if (!m) return;
    const p = tokenPrice(m);
    out.push({ id, w: p ? p.prompt * 10 + p.completion : Number.POSITIVE_INFINITY, i });
  });
  if (out.length === 0) throw new SafetyLlmError('unavailable', 'no vision-capable chat model is in the catalog');
  return out.sort((a, b) => a.w - b.w || a.i - b.i).map((m) => m.id);
}

export interface TextClassifyInput {
  prompt: string;
  negativePrompt?: string;
  captions: string[];
  mature: boolean;
}

export async function classifyText(
  llm: LlmProvider,
  model: string,
  input: TextClassifyInput,
  key: string,
  timeoutMs = TEXT_TIMEOUT_MS,
): Promise<LlmCallResult<TextAssessment>> {
  const user = JSON.stringify({
    mature_run: input.mature,
    prompt: input.prompt.slice(0, 6000),
    ...(input.negativePrompt && { negative_prompt: input.negativePrompt.slice(0, 1000) }),
    ...(input.captions.length > 0 && { reference_captions: input.captions.map((c) => c.slice(0, 300)).slice(0, 10) }),
  });
  const res = await collect(
    llm,
    { model, messages: [{ role: 'system', content: TEXT_SYSTEM }, { role: 'user', content: user }], maxTokens: 300, idempotencyKey: key, json: true },
    timeoutMs,
  );
  const parsed = TextAssessmentSchema.safeParse(parseJsonObject(res.text));
  if (!parsed.success) throw new SafetyLlmError('invalid', `text classifier answer failed validation: ${parsed.error.issues[0]?.path.join('.')}`);
  return { value: parsed.data, model, ms: res.ms, ...(res.costUsd !== undefined && { costUsd: res.costUsd }) };
}

/** Rates up to VISION_BATCH images in one request. */
export async function classifyImages(
  llm: LlmProvider,
  models: readonly string[],
  urls: readonly string[],
  context: string,
  key: string,
  timeoutMs = VISION_TIMEOUT_MS,
): Promise<LlmCallResult<ImageAssessment[]>> {
  const parts: ChatContentPart[] = [
    { type: 'text', text: `${urls.length} image(s). Generation prompt for context (may be empty): ${JSON.stringify(context.slice(0, 1500))}` },
    ...urls.map((u): ChatContentPart => ({ type: 'image_url', imageUrl: u })),
  ];
  const res = await collect(
    llm,
    { model: models[0]!, fallbackModels: models.slice(1), messages: [{ role: 'system', content: VISION_SYSTEM }, { role: 'user', content: parts }], maxTokens: 120 + 120 * urls.length, idempotencyKey: key, json: true },
    timeoutMs,
  );
  const parsed = VisionAnswerSchema.safeParse(parseJsonObject(res.text));
  if (!parsed.success) throw new SafetyLlmError('invalid', `vision classifier answer failed validation: ${parsed.error.issues[0]?.path.join('.')}`);
  if (parsed.data.images.length !== urls.length) {
    throw new SafetyLlmError('invalid', `vision classifier rated ${parsed.data.images.length} of ${urls.length} images`);
  }
  return { value: parsed.data.images, model: models[0]!, ms: res.ms, ...(res.costUsd !== undefined && { costUsd: res.costUsd }) };
}

/** `lumina/face-detect` (JPEG or PNG, ≤ 5 MB). */
export async function detectFaces(llm: LlmProvider, url: string, key: string, timeoutMs = VISION_TIMEOUT_MS): Promise<LlmCallResult<FaceResult>> {
  const res = await collect(
    llm,
    { model: FACE_DETECT_MODEL, messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: url }] }], maxTokens: 1024, idempotencyKey: key, json: false },
    timeoutMs,
  );
  const parsed = FaceAnswerSchema.safeParse(parseJsonObject(res.text));
  if (!parsed.success) throw new SafetyLlmError('invalid', 'face-detect answer failed validation');
  return {
    value: faceResultOf(parsed.data.faces),
    model: FACE_DETECT_MODEL,
    ms: res.ms,
    ...(res.costUsd !== undefined && { costUsd: res.costUsd }),
  };
}
