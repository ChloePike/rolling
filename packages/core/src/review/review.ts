/**
 * The review call (D-024): one request to the cheapest vision-capable chat
 * model on the gateway (the safety vision list, D-002), all takes of a job in
 * order, strict JSON back. Failures never fail the job: the caller stores no
 * review.
 */
import { collect, SafetyLlmError, visionModelsFor, type ChatCatalog } from '../safety/llm';
import { tokenPrice } from '../models/chat';
import type { ChatContentPart, LlmProvider } from '../models/types';
import { QUALITY_REVIEW, reviewMaxUsd } from '../pricing/config';
import { buildReview, overallScore, ratioIssue, takeVerdict, withRatioCheck } from './decide';
import { promptLocale } from '../generation/plan';
import { parseReviewAnswer, REVIEW_DIMENSIONS, type ResultReview, type ReviewFix } from './types';

export const REVIEW_TIMEOUT_MS = 30_000;

export interface ReviewCharacter {
  name: string;
  look: string;
  wardrobe?: string;
}

export interface ReviewTake {
  /** One picture for an image; up to two frames (data or https URLs) for a clip, in time order. */
  pictures: string[];
  /** Pixel size of the output when known (the deterministic ratio check). */
  width?: number;
  height?: number;
}

export interface ReviewInput {
  kind: 'image' | 'video';
  /** The prompt as the user sees it (canonical text of a planned shot). */
  prompt: string;
  /** The rewrite that rendered (D-020), when the gateway expanded the prompt. */
  expandedPrompt?: string | null;
  negativePrompt?: string;
  ratio?: string;
  seconds?: number;
  /** Takes the run asked for (count). */
  count: number;
  characters: ReviewCharacter[];
  /** Reference pictures the run declared (characters, products), with their labels. */
  references: { label: string; url: string }[];
  takes: ReviewTake[];
  /** Text that must read exactly in the picture (a planned shot's `text`). */
  requiredText?: string;
}

const SYSTEM = [
  'You review AI-generated images and video frames the way a film director reviews takes. You never write content; you judge it.',
  'Score each take 1 to 5 per dimension (5 = no visible problem, 3 = noticeable, 1 = unusable). Use null when a dimension does not apply.',
  '- anatomy: hands (finger count, fused or extra fingers), faces (eyes, teeth, symmetry), limbs (count, joints, impossible bends). null when no person or animal is visible.',
  '- text: garbled, misspelled or unwanted text, watermarks, logos or brand marks the prompt did not ask for. Required text must read exactly. 5 when there is no text and none was asked for.',
  '- adherence: the subject, action, setting and count the prompt asks for are there (two people means two people).',
  '- continuity: the character matches the declared descriptors and the reference picture (face, hair, wardrobe, colors). null when no character or reference is declared.',
  '- framing: the shot size and composition fit the prompt; nothing important is cut off; the frame is not letterboxed or padded.',
  '- artifacts: melting or smeared areas, duplicated objects or body parts, warped backgrounds; for a clip, frames that disagree (an object that appears, vanishes or changes shape between frames hints at flicker).',
  'List each problem as an issue: {"dimension","severity":"minor|major","note"}. A note is at most 12 words, concrete and visual ("left hand has six fingers"), sentence case, no hype.',
  'When a take has a problem worth another try, give a fix: {"prompt": the whole revised prompt, starting from the brief\'s "prompt" (never from "rendered_prompt"), in the same language as it, keeping the user\'s words and adding only what fixes the problem, "negativePrompt": comma-separated terms to avoid, "newSeed": true when only luck is at fault, "note": what the fix changes in at most 10 words}. Use null when the take is fine.',
  'Judge only what you see. Do not describe the picture. Do not rate content safety.',
  'Answer with one JSON object and nothing else: {"takes":[{"scores":{"anatomy":n|null,"text":n|null,"adherence":n|null,"continuity":n|null,"framing":n|null,"artifacts":n|null},"issues":[...],"fix":{...}|null}, ...one per take, in order]}',
].join('\n');

/** The user message: the brief, then the reference pictures, then each take's pictures, each announced by a text part. */
export function reviewMessages(input: ReviewInput): { system: string; parts: ChatContentPart[] } {
  const brief: Record<string, unknown> = {
    kind: input.kind,
    prompt: input.prompt.slice(0, 2500),
    ...(input.expandedPrompt && { rendered_prompt: input.expandedPrompt.slice(0, 2500) }),
    ...(input.negativePrompt && { avoid: input.negativePrompt.slice(0, 400) }),
    ...(input.ratio && { aspect_ratio: input.ratio }),
    ...(input.kind === 'video' && input.seconds && { seconds: input.seconds }),
    takes_asked: input.count,
    ...(input.characters.length > 0 && { characters: input.characters.slice(0, 4) }),
    ...(input.requiredText && { required_text: input.requiredText.slice(0, 200) }),
  };
  const parts: ChatContentPart[] = [{ type: 'text', text: `Brief: ${JSON.stringify(brief)}\n${input.takes.length} take(s) follow.` }];
  for (const r of input.references.slice(0, QUALITY_REVIEW.maxReferences)) {
    parts.push({ type: 'text', text: `Reference picture "${r.label.slice(0, 60)}" (for continuity, not a take):` });
    parts.push({ type: 'image_url', imageUrl: r.url });
  }
  input.takes.slice(0, QUALITY_REVIEW.maxTakes).forEach((t, i) => {
    const pics = t.pictures.slice(0, QUALITY_REVIEW.maxPicturesPerTake);
    const what = input.kind === 'video' ? (pics.length > 1 ? `${pics.length} frames in time order` : 'one frame') : 'the image';
    parts.push({ type: 'text', text: `Take ${i + 1} (${what}):` });
    for (const p of pics) parts.push({ type: 'image_url', imageUrl: p });
  });
  return { system: SYSTEM, parts };
}

/** Script family of a prompt (Latin languages count as one): what a revised prompt must keep. */
function scriptOf(text: string): string | undefined {
  const tag = promptLocale(text);
  if (!tag) return undefined;
  return ['ja', 'ko', 'zh', 'ru', 'ar', 'th'].find((p) => tag.startsWith(p)) ?? 'latin';
}

/**
 * A revised prompt replaces the user's prompt on the node ("Retry with fix"), so it must be
 * the user's prompt revised, not the gateway's rewrite (D-020) in another language: a fix
 * prompt in another script than the user's prompt, or one that repeats the rendered rewrite,
 * is dropped; the negative terms stay, and a fresh seed stands in when nothing else is left.
 */
export function fixForPrompt(fix: ReviewFix | null, prompt: string, expandedPrompt?: string | null): ReviewFix | null {
  if (!fix?.prompt) return fix;
  const sameScript = scriptOf(fix.prompt) === scriptOf(prompt);
  const rendered = expandedPrompt?.trim() ? fix.prompt.includes(expandedPrompt.trim().slice(0, 80)) : false;
  if (sameScript && !rendered) return fix;
  const { prompt: _dropped, ...rest } = fix;
  return rest.negativePrompt || rest.newSeed ? rest : { ...rest, newSeed: true };
}

export class ReviewError extends Error {
  override readonly name = 'ReviewError';
  constructor(
    readonly code: 'unavailable' | 'too_costly' | 'invalid' | 'upstream' | 'timeout' | 'no_pictures',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The review models available, cheapest first, with the first one's worst-case
 * cost for this input; refuses (`too_costly`) above `QUALITY_REVIEW.maxUsdPerOutput` per take.
 */
export function reviewPlan(available: ChatCatalog, input: Pick<ReviewInput, 'takes' | 'references'>): { models: string[]; maxUsd: number } {
  let models: string[];
  try {
    models = visionModelsFor(available);
  } catch {
    throw new ReviewError('unavailable', 'no vision-capable chat model is in the catalog');
  }
  const first = available.find((m) => m.id === models[0]);
  const price = first ? tokenPrice(first) : null;
  if (!price) throw new ReviewError('unavailable', `no token price for ${models[0]}`);
  const takes = Math.min(QUALITY_REVIEW.maxTakes, input.takes.length);
  const perTake = Math.max(1, ...input.takes.map((t) => t.pictures.length));
  const maxUsd = reviewMaxUsd(takes, perTake, input.references.length, price);
  if (maxUsd > QUALITY_REVIEW.maxUsdPerOutput * takes) throw new ReviewError('too_costly', `review would cost up to $${maxUsd.toFixed(4)}`);
  return { models, maxUsd };
}

/** Reviews a job's takes; the takes beyond `QUALITY_REVIEW.maxTakes` are not reviewed (and keep their place). */
export async function reviewOutputs(
  llm: LlmProvider,
  available: ChatCatalog,
  input: ReviewInput,
  idempotencyKey: string,
  timeoutMs = REVIEW_TIMEOUT_MS,
): Promise<ResultReview> {
  const takes = input.takes.slice(0, QUALITY_REVIEW.maxTakes);
  if (takes.length === 0 || takes.some((t) => t.pictures.length === 0)) throw new ReviewError('no_pictures', 'a take has no picture to review');
  const { models } = reviewPlan(available, { ...input, takes });
  const { system, parts } = reviewMessages({ ...input, takes });
  let res: Awaited<ReturnType<typeof collect>>;
  try {
    res = await collect(
      llm,
      {
        model: models[0]!,
        fallbackModels: models.slice(1),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: parts },
        ],
        maxTokens: 200 + QUALITY_REVIEW.outputTokensPerTake * takes.length,
        idempotencyKey,
        json: true,
      },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof SafetyLlmError) throw new ReviewError(err.code === 'timeout' ? 'timeout' : 'upstream', err.message);
    throw new ReviewError('upstream', err instanceof Error ? err.message : String(err));
  }
  let parsed: ReturnType<typeof parseReviewAnswer>;
  try {
    parsed = parseReviewAnswer(res.text, takes.length, overallScore);
  } catch (err) {
    throw new ReviewError('invalid', err instanceof Error ? err.message : String(err));
  }
  const verdicts = parsed.map((t, i) => {
    const v = takeVerdict({ scores: t.scores, issues: t.issues, fix: fixForPrompt(t.fix, input.prompt, input.expandedPrompt) });
    // Continuity without a declared character or reference is not judged.
    if (input.characters.length === 0 && input.references.length === 0) v.scores.continuity = null;
    const fixed = takeVerdict({ scores: v.scores, issues: v.issues.filter((x) => REVIEW_DIMENSIONS.includes(x.dimension) && (x.dimension !== 'continuity' || v.scores.continuity !== null)), fix: v.fix });
    return withRatioCheck(fixed, ratioIssue(input.ratio, takes[i]!.width, takes[i]!.height));
  });
  return buildReview({ model: models[0]!, costUsd: res.costUsd ?? null, takes: verdicts });
}
