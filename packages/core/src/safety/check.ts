/**
 * D-005 hard limits: `preCheck` (prompt and references, before any provider
 * call), `postCheck` (outputs, before they are committed) and `rateMedia`
 * (content rating of any picture or clip, uploads included).
 *
 * Order: deterministic rules → text classifier → vision on image references
 * (mature runs) → face detection on uploaded references (mature runs).
 * Fail closed: a classifier error or timeout on a mature run blocks with
 * SAFETY_UNAVAILABLE; non-mature runs pass when the rules pass, and the
 * outage is recorded in `checks` for the log.
 */
import type { LlmProvider } from '../models/types';
import {
  classifyImages,
  classifyText,
  detectFaces,
  SAFETY_PROMPT_VERSION,
  SafetyLlmError,
  textModelFor,
  VISION_BATCH,
  visionModelsFor,
  type ChatCatalog,
  type FaceResult,
  type ImageAssessment,
  type TextAssessment,
} from './llm';
import { runRules } from './rules';
import type {
  CheckRecord,
  PostCheckInput,
  PreCheckInput,
  Rating,
  RatingResult,
  SafetyCode,
  SafetyOutput,
  SafetyReason,
  SafetyVerdict,
  VerdictCache,
} from './types';

export interface SafetyDeps {
  /** Chat adapter; null = classifiers unavailable (treated as an outage). */
  llm: LlmProvider | null;
  /** Synced chat catalog (cheapest routes). */
  chatModels: ChatCatalog;
  cache?: VerdictCache | null;
  /** Idempotency key for each gateway call. */
  newKey: () => string;
  textTimeoutMs?: number;
  visionTimeoutMs?: number;
  /** Face-detect confidence (0..100) above which a face counts. */
  faceThreshold?: number;
}

const FACE_THRESHOLD = 90;
const RATING_RANK: Record<Rating, number> = { safe: 0, suggestive: 1, explicit: 2 };

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cached<T>(deps: SafetyDeps, key: string | null, run: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  if (key && deps.cache) {
    try {
      const hit = await deps.cache.get(key);
      if (hit !== null && hit !== undefined) return { value: hit as T, hit: true };
    } catch {
      // Cache read failures never block a check.
    }
  }
  const value = await run();
  if (key && deps.cache) {
    try {
      await deps.cache.put(key, value);
    } catch {
      // Best effort.
    }
  }
  return { value, hit: false };
}

function errorNote(err: unknown): string {
  return err instanceof SafetyLlmError ? err.code : 'error';
}

/** Hard-limit reasons from a text assessment (plus MATURE_REQUIRED on non-mature runs). */
export function textReasons(a: TextAssessment, mature: boolean): SafetyReason[] {
  const out: SafetyReason[] = [];
  if (a.minorSexualized || (a.apparentMinor && (a.sexualLevel !== 'none' || mature))) {
    out.push({ code: 'MINOR_SEXUAL', detail: `text: apparent minor with sexual level ${a.sexualLevel}${mature ? ' on a mature run' : ''}` });
  }
  if (a.realPerson && (a.realPersonSexualOrIntimate || a.sexualLevel !== 'none')) {
    out.push({ code: 'REAL_PERSON_SEXUAL', detail: `text: real person (${a.realPersonNames.slice(0, 3).join(', ') || 'unnamed'}) with sexual level ${a.sexualLevel}` });
  }
  if (a.nonConsensualSexual) out.push({ code: 'NON_CONSENSUAL', detail: 'text: non-consensual sexual content' });
  if (a.animalSexual) out.push({ code: 'ANIMAL_SEXUAL', detail: 'text: sexual content involving an animal' });
  if (a.extremeViolence) out.push({ code: 'EXTREME_VIOLENCE', detail: 'text: real-world extreme violence or gore' });
  if (a.violentExtremism) out.push({ code: 'VIOLENT_EXTREMISM', detail: 'text: violent-extremist content' });
  if (a.selfHarm) out.push({ code: 'SELF_HARM', detail: 'text: self-harm' });
  if (!mature && a.sexualLevel === 'explicit' && out.length === 0) out.push({ code: 'MATURE_REQUIRED', detail: 'text: explicit content on a non-mature run' });
  return out;
}

/**
 * Hard-limit reasons from an image assessment. `mature` is the run's flag;
 * `upload` marks a user upload; `face` is the face-detect result when known.
 */
export function imageReasons(a: ImageAssessment, opts: { mature: boolean; upload?: boolean; face?: FaceResult | null; label: string; threshold?: number }): SafetyReason[] {
  const out: SafetyReason[] = [];
  const sexual = a.rating !== 'safe';
  if (a.minorSexualized || (a.apparentMinor && (sexual || opts.mature))) {
    out.push({ code: 'MINOR_SEXUAL', detail: `${opts.label}: apparent minor, rating ${a.rating}${opts.mature ? ', mature run' : ''}` });
  }
  if (a.knownPerson && (sexual || opts.mature)) out.push({ code: 'REAL_PERSON_SEXUAL', detail: `${opts.label}: recognizable person, rating ${a.rating}` });
  // Face-detect age estimates feed the minor rule too (any face under 18 on sexual media or a mature run).
  if (opts.face?.apparentMinor && opts.face.faces > 0 && (sexual || opts.mature)) {
    out.push({ code: 'MINOR_SEXUAL', detail: `${opts.label}: face detection estimates a minor${opts.mature ? ', mature run' : ''}` });
  }
  const realFace = opts.upload && opts.face && opts.face.faces > 0 && opts.face.maxConfidence >= (opts.threshold ?? FACE_THRESHOLD) && a.photographic;
  if (realFace && opts.mature) out.push({ code: 'REAL_PERSON_SEXUAL', detail: `${opts.label}: uploaded photo of a real face on a mature run` });
  if (a.animalSexual) out.push({ code: 'ANIMAL_SEXUAL', detail: `${opts.label}: sexual content involving an animal` });
  if (a.extremeViolence) out.push({ code: 'EXTREME_VIOLENCE', detail: `${opts.label}: extreme violence or gore` });
  if (a.violentExtremism) out.push({ code: 'VIOLENT_EXTREMISM', detail: `${opts.label}: violent-extremist imagery` });
  if (a.selfHarm) out.push({ code: 'SELF_HARM', detail: `${opts.label}: self-harm imagery` });
  return out;
}

function dedupe(reasons: SafetyReason[]): SafetyReason[] {
  const seen = new Set<SafetyCode>();
  return reasons.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)));
}

function verdictOf(reasons: SafetyReason[], checks: CheckRecord[], rating?: RatingResult | null): SafetyVerdict {
  const r = dedupe(reasons);
  return { verdict: r.length ? 'block' : 'allow', reasons: r, checks, ...(rating !== undefined && { rating }) };
}

/** Rates images in batches; returns assessments in input order (cached by hash or URL). */
async function rateImages(
  deps: SafetyDeps,
  items: readonly { url: string; hash?: string }[],
  context: string,
  checks: CheckRecord[],
): Promise<{ assessments: ImageAssessment[]; model: string } | null> {
  if (!deps.llm) {
    checks.push({ name: 'vision', status: 'error', note: 'unavailable' });
    return null;
  }
  let models: string[];
  try {
    models = visionModelsFor(deps.chatModels);
  } catch (err) {
    checks.push({ name: 'vision', status: 'error', note: errorNote(err) });
    return null;
  }
  const model = models[0]!;
  const out: (ImageAssessment | undefined)[] = new Array(items.length);
  const keys = await Promise.all(items.map(async (i) => `img:${SAFETY_PROMPT_VERSION}:${i.hash ?? (await sha256Hex(i.url))}`));
  const missing: number[] = [];
  if (deps.cache) {
    await Promise.all(
      keys.map(async (k, idx) => {
        try {
          const hit = (await deps.cache!.get(k)) as ImageAssessment | null;
          if (hit) out[idx] = hit;
        } catch {
          // ignore
        }
      }),
    );
  }
  items.forEach((_, idx) => {
    if (!out[idx]) missing.push(idx);
  });
  if (missing.length < items.length) checks.push({ name: 'vision', status: 'pass', model, cached: true, note: `${items.length - missing.length} cached` });
  for (let i = 0; i < missing.length; i += VISION_BATCH) {
    const batch = missing.slice(i, i + VISION_BATCH);
    try {
      const res = await classifyImages(deps.llm, models, batch.map((idx) => items[idx]!.url), context, deps.newKey(), deps.visionTimeoutMs);
      batch.forEach((idx, j) => (out[idx] = res.value[j]));
      checks.push({ name: 'vision', status: 'pass', model, ms: res.ms, ...(res.costUsd !== undefined && { costUsd: res.costUsd }), note: `${batch.length} image(s)` });
      if (deps.cache) await Promise.all(batch.map((idx) => deps.cache!.put(keys[idx]!, out[idx]).catch(() => undefined)));
    } catch (err) {
      checks.push({ name: 'vision', status: 'error', model, note: errorNote(err) });
      return null;
    }
  }
  return { assessments: out as ImageAssessment[], model };
}

function maxRating(assessments: readonly ImageAssessment[], model: string): RatingResult | null {
  let best: ImageAssessment | null = null;
  for (const a of assessments) {
    if (!best || RATING_RANK[a.rating] > RATING_RANK[best.rating] || (a.rating === best.rating && a.confidence > best.confidence)) best = a;
  }
  return best ? { rating: best.rating, confidence: best.confidence, model } : null;
}

/** Only the deterministic rules (cheap; used by the quote endpoint). */
export function quickCheck(input: PreCheckInput): SafetyVerdict & { explicit: string[] } {
  const t0 = Date.now();
  const rules = runRules(input);
  const checks: CheckRecord[] = [{ name: 'rules', status: rules.reasons.length ? 'block' : 'pass', ms: Date.now() - t0 }];
  return { ...verdictOf(rules.reasons, checks), explicit: rules.explicit };
}

export async function preCheck(input: PreCheckInput, deps: SafetyDeps): Promise<SafetyVerdict> {
  const quick = quickCheck(input);
  const checks = [...quick.checks];
  // Deterministic hard-limit hits block without spending on classifiers.
  if (quick.verdict === 'block') return verdictOf(quick.reasons, checks);
  const reasons: SafetyReason[] = [];
  let needsMature = false;
  const failClosed = (detail: string) => reasons.push({ code: 'SAFETY_UNAVAILABLE', detail });

  // Text classifier.
  const captions = input.references.map((r) => r.caption ?? '').filter(Boolean);
  if (!deps.llm) {
    checks.push({ name: 'text', status: 'error', note: 'unavailable' });
    if (input.mature) failClosed('text classifier unavailable');
  } else {
    let model = '';
    try {
      model = textModelFor(deps.chatModels);
      const key = `txt:${SAFETY_PROMPT_VERSION}:${await sha256Hex(JSON.stringify([input.prompt, input.negativePrompt ?? '', captions, input.mature]))}`;
      const t0 = Date.now();
      let costUsd: number | undefined;
      const { value, hit } = await cached(deps, key, async () => {
        const ask = () => classifyText(deps.llm!, model, { prompt: input.prompt, ...(input.negativePrompt && { negativePrompt: input.negativePrompt }), captions, mature: input.mature }, deps.newKey(), deps.textTimeoutMs);
        // One retry on a timeout: on a mature run a classifier timeout blocks (fail closed), which the user sees as a false block.
        const res = await ask().catch((err: unknown) => {
          if (err instanceof SafetyLlmError && err.code === 'timeout') return ask();
          throw err;
        });
        costUsd = res.costUsd;
        return res.value;
      });
      let r = textReasons(value, input.mature);
      // D-005: a mature-allowed caller is never asked to turn mature content on; the run is re-planned as mature.
      if (input.matureAllowed && r.some((x) => x.code === 'MATURE_REQUIRED')) {
        r = r.filter((x) => x.code !== 'MATURE_REQUIRED');
        needsMature = true;
      }
      reasons.push(...r);
      checks.push({ name: 'text', status: r.length ? 'block' : 'pass', model, ms: Date.now() - t0, ...(hit && { cached: true }), ...(costUsd !== undefined && { costUsd }) });
    } catch (err) {
      checks.push({ name: 'text', status: 'error', ...(model && { model }), note: errorNote(err) });
      if (input.mature) failClosed(`text classifier ${errorNote(err)}`);
    }
  }

  // Vision and faces on image references of mature runs.
  const images = input.references.filter((r) => r.kind === 'image' && r.url);
  if (input.mature && images.length > 0) {
    const rated = await rateImages(deps, images.map((r) => ({ url: r.url!, ...(r.hash && { hash: r.hash }) })), input.prompt, checks);
    if (!rated) failClosed('vision classifier unavailable for references');
    else {
      for (const [i, ref] of images.entries()) {
        let face: FaceResult | null = null;
        // Face detection (the costliest check, ~$0.0013) only for uploaded photographs.
        if (ref.source === 'upload' && ref.face) {
          // Stored at upload (media processing): no second detection.
          face = ref.face;
          checks.push({ name: 'faces', status: 'pass', model: 'lumina/face-detect', cached: true, note: `${face.faces} face(s), stored at upload` });
        } else if (ref.source === 'upload' && rated.assessments[i]!.photographic) {
          try {
            const key = `face:${ref.hash ?? (await sha256Hex(ref.url!))}`;
            const t0 = Date.now();
            let costUsd: number | undefined;
            const { value, hit } = await cached(deps, key, async () => {
              const res = await detectFaces(deps.llm!, ref.url!, deps.newKey(), deps.visionTimeoutMs);
              costUsd = res.costUsd;
              return res.value;
            });
            face = value;
            checks.push({ name: 'faces', status: 'pass', model: 'lumina/face-detect', ms: Date.now() - t0, ...(hit && { cached: true }), ...(costUsd !== undefined && { costUsd }), note: `${value.faces} face(s)` });
          } catch (err) {
            checks.push({ name: 'faces', status: 'error', model: 'lumina/face-detect', note: errorNote(err) });
            failClosed(`face detection ${errorNote(err)}`);
            continue;
          }
        }
        const r = imageReasons(rated.assessments[i]!, {
          mature: true,
          upload: ref.source === 'upload',
          face,
          label: `reference ${i + 1} (${ref.source})`,
          ...(deps.faceThreshold !== undefined && { threshold: deps.faceThreshold }),
        });
        reasons.push(...r);
      }
    }
  }
  // A hard-limit hit outranks the outage code.
  const hard = reasons.filter((r) => r.code !== 'SAFETY_UNAVAILABLE');
  const v = verdictOf(hard.length ? hard : reasons, checks);
  return needsMature && v.verdict === 'allow' ? { ...v, needsMature: true } : v;
}

/**
 * D-020: the prompt the gateway's expansion actually rendered (`expanded_prompt`)
 * gets the same text checks as the user's prompt (rules, then the text
 * classifier), so a rewrite cannot add a hard limit the user's words did not
 * have. Mature-allowed callers and mature runs are blocked only by hard limits;
 * other callers also by explicit content (MATURE_REQUIRED). Classifier outages
 * fail closed on mature runs, as in `preCheck`.
 */
export async function expandedPromptCheck(input: { expandedPrompt: string; mature: boolean; matureAllowed?: boolean }, deps: SafetyDeps): Promise<SafetyVerdict> {
  const v = await preCheck({ prompt: input.expandedPrompt, references: [], mature: input.mature, ...(input.matureAllowed !== undefined && { matureAllowed: input.matureAllowed }) }, deps);
  // Rating the output decides visibility; an explicit rewrite of a mature-allowed caller is not re-planned here.
  const { needsMature: _ignored, ...rest } = v;
  return rest;
}

/** The pictures a check looks at: an image output itself, a video's frames. */
function picturesOf(outputs: readonly SafetyOutput[]): { pictures: { url: string; hash?: string; output: number }[]; unframed: number } {
  const pictures: { url: string; hash?: string; output: number }[] = [];
  let unframed = 0;
  outputs.forEach((o, i) => {
    if (o.kind === 'image' && o.url) pictures.push({ url: o.url, ...(o.hash && { hash: o.hash }), output: i });
    else if (o.kind === 'video') {
      const frames = (o.frames ?? []).slice(0, 3);
      if (frames.length === 0) unframed++;
      frames.forEach((f, j) => pictures.push({ url: f, ...(o.hash && { hash: `${o.hash}.f${j}` }), output: i }));
    }
  });
  return { pictures, unframed };
}

/**
 * Checks outputs before they are committed. Image outputs are rated
 * themselves, videos through their frames (skipped when no frame is
 * available: the pre-check and the log stand). Non-mature runs that produce
 * explicit output are blocked with MATURE_REQUIRED, unless the caller is
 * mature-allowed (then only hard limits block).
 */
export async function postCheck(input: PostCheckInput, deps: SafetyDeps): Promise<SafetyVerdict> {
  const checks: CheckRecord[] = [];
  const { pictures, unframed } = picturesOf(input.outputs);
  if (unframed > 0) checks.push({ name: 'vision', status: 'skipped', note: `${unframed} video(s) without frames` });
  if (pictures.length === 0) return verdictOf([], checks, null);
  const rated = await rateImages(deps, pictures, input.prompt, checks);
  if (!rated) {
    return verdictOf(input.mature ? [{ code: 'SAFETY_UNAVAILABLE', detail: 'vision classifier unavailable for outputs' }] : [], checks, null);
  }
  const reasons: SafetyReason[] = [];
  rated.assessments.forEach((a, i) => reasons.push(...imageReasons(a, { mature: input.mature, label: `output ${pictures[i]!.output + 1}` })));
  const rating = maxRating(rated.assessments, rated.model);
  // D-005: for a mature-allowed caller explicit output only rates (visibility), it never blocks.
  if (!input.mature && !input.matureAllowed && rating?.rating === 'explicit' && reasons.length === 0) reasons.push({ code: 'MATURE_REQUIRED', detail: 'output rated explicit on a non-mature run' });
  return verdictOf(reasons, checks, rating);
}

/**
 * Content rating of one picture or clip (uploads, outputs). Also reports hard
 * limits visible in the media itself (an upload never blocks a run by itself;
 * the caller decides). Rating is null when the classifier is unavailable.
 */
export async function rateMedia(media: SafetyOutput & { source?: 'upload' | 'generated'; face?: FaceResult | null }, deps: SafetyDeps): Promise<SafetyVerdict> {
  const checks: CheckRecord[] = [];
  const { pictures, unframed } = picturesOf([media]);
  if (unframed > 0) checks.push({ name: 'vision', status: 'skipped', note: 'video without frames' });
  if (pictures.length === 0) return verdictOf([], checks, null);
  const rated = await rateImages(deps, pictures, '', checks);
  if (!rated) return verdictOf([], checks, null);
  const reasons: SafetyReason[] = [];
  rated.assessments.forEach((a) => reasons.push(...imageReasons(a, { mature: false, upload: media.source === 'upload', face: media.face ?? null, label: media.source ?? 'media' })));
  return verdictOf(reasons, checks, maxRating(rated.assessments, rated.model));
}

/** Face detection of one picture for asset processing; `ok: false` when the detector is unavailable or answers badly. */
export type FaceDetection = { ok: true; value: FaceResult; cached: boolean; costUsd?: number } | { ok: false; note: string };

/**
 * `lumina/face-detect` on an uploaded picture (an image, or a video's poster frame), for `assets.meta.faces`.
 * Shares the verdict cache key with `preCheck` (`face:<content hash>`), so a run that uses the upload reuses it.
 */
export async function detectUploadFaces(picture: { url: string; hash?: string }, deps: SafetyDeps): Promise<FaceDetection> {
  if (!deps.llm) return { ok: false, note: 'unavailable' };
  try {
    const key = `face:${picture.hash ?? (await sha256Hex(picture.url))}`;
    let costUsd: number | undefined;
    const { value, hit } = await cached(deps, key, async () => {
      const res = await detectFaces(deps.llm!, picture.url, deps.newKey(), deps.visionTimeoutMs);
      costUsd = res.costUsd;
      return res.value;
    });
    return { ok: true, value, cached: hit, ...(costUsd !== undefined && { costUsd }) };
  } catch (err) {
    return { ok: false, note: errorNote(err) };
  }
}

/** D-005 visibility: suggestive and explicit media are mature (blurred, never public, signed only for allowed viewers). */
export function isMatureRating(rating: Rating | null | undefined): boolean {
  return rating === 'suggestive' || rating === 'explicit';
}
