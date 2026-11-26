/**
 * Auto model selection (D-009). Candidates are the Auto-eligible catalog models
 * that fit the request's capabilities, the plan's resolution cap (D-006) and
 * mature routing (D-005). An injected LLM classifier picks one of them; its
 * answer must be a candidate id (Zod-validated). Garbage, a timeout (2 s) or an
 * error fall back to the deterministic `pickAuto` (cheapest capable model).
 */
import { z } from 'zod';
import type { Catalog } from '../models/catalog';
import { estimateUsd, unmetCapability, type AutoRequest } from '../models/capabilities';
import { resolveChatModel } from '../models/chat';
import { isSwapModel } from '../models/overlay';
import type { CatalogModel, ChatMessage, LlmProvider } from '../models/types';
import { planAllowsResolution, type PlanId } from '../pricing/config';

export const AUTO_CLASSIFIER_TIMEOUT_MS = 4000;
/** Public chat id of the classifier model (cheapest DeepSeek V4.1 Flash route). */
export const AUTO_CLASSIFIER_CHAT_MODEL = 'deepseek-v4.1-flash';

export interface AutoCandidate {
  id: string;
  name: string;
  tags: string[];
  /** Gateway USD for this request (relative cost signal for the classifier). */
  usd: number;
  default: boolean;
}

/** What the classifier sees. No user ids, no URLs. */
export interface ClassifyInput {
  prompt: string;
  kind: 'image' | 'video';
  mode: string;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  references: number;
  candidates: AutoCandidate[];
}

/** Returns the classifier's raw answer (anything); `chooseModel` validates it. */
export type Classify = (input: ClassifyInput, signal: AbortSignal) => Promise<unknown>;

export interface ChooseModelInput {
  request: AutoRequest & { prompt: string };
  candidates: readonly CatalogModel[];
  classify?: Classify | null;
  timeoutMs?: number;
}

export interface ChooseModelResult {
  model: CatalogModel;
  via: 'classifier' | 'fallback' | 'single';
  /** Other candidates for the one Auto retry, cheapest first. */
  fallbacks: CatalogModel[];
  /** Why the classifier answer was not used, for logs. */
  fallbackReason?: 'timeout' | 'error' | 'invalid';
}

function priceOf(model: CatalogModel, req: AutoRequest): number | null {
  return estimateUsd(model, {
    ...(req.resolution !== undefined && { resolution: req.resolution }),
    ...(req.audio !== undefined && { audio: req.audio }),
    ...(req.n !== undefined && { n: req.n }),
    seconds: req.seconds ?? 5,
    inputImages: (req.inputImages ?? 0) + (req.referenceImages ?? 0),
    referenceVideos: req.referenceVideos ?? 0,
  });
}

/**
 * The request as one model would take it: optional settings the model has no
 * control for are dropped (ratio, audio, resolution, length), and one audio
 * track goes to a lip-sync model's `audio_url` instead of the references.
 */
export function fitRequest<T extends AutoRequest>(model: CatalogModel, req: T): T {
  const out = { ...req };
  if (model.ratios.length === 0) delete out.ratio;
  if (!model.audio) delete out.audio;
  if (model.resolutions.length === 0) delete out.resolution;
  if (!model.seconds) delete out.seconds;
  if (model.lipSync && (out.referenceAudios ?? 0) === 1) out.referenceAudios = 0;
  return out;
}

/**
 * Auto candidates for a request, cheapest first: Auto-eligible, listed, not
 * identity-driven, capable, priceable and within the plan's resolution cap.
 */
function capableCandidates(
  models: readonly CatalogModel[],
  req: AutoRequest,
  plan: PlanId | null,
  include: (model: CatalogModel) => boolean,
): CatalogModel[] {
  const out: { model: CatalogModel; usd: number }[] = [];
  for (const model of models) {
    if (!include(model)) continue;
    if (model.kind !== 'image' && model.kind !== 'video') continue;
    const fitted = fitRequest(model, req);
    if (unmetCapability(model, fitted) !== null) continue;
    const resolution = model.kind === 'image' && model.resolutions.length === 0 ? req.resolution : (fitted.resolution ?? model.defaultResolution);
    if (plan && resolution && !planAllowsResolution(plan, model.kind, resolution)) continue;
    const usd = priceOf(model, fitted);
    if (usd === null) continue;
    out.push({ model, usd });
  }
  out.sort((a, b) => a.usd - b.usd || (a.model.default === b.model.default ? (a.model.id < b.model.id ? -1 : 1) : a.model.default ? -1 : 1));
  return out.map((c) => c.model);
}

export function autoCandidates(catalog: Catalog | readonly CatalogModel[], req: AutoRequest, plan: PlanId | null): CatalogModel[] {
  const models = 'models' in catalog ? catalog.models : catalog;
  return capableCandidates(models, req, plan, (m) => m.auto && !m.hidden && !m.requiresIdentitySafety);
}

/**
 * Every listed model that takes a mature run of this request without an asset
 * check (D-005 `matureRouting: 'allowed'`), Auto-eligible or not (the spicy
 * family is not Auto-eligible), cheapest first. Used when a run becomes mature
 * and its model can't take it.
 */
export function matureCandidates(catalog: Catalog | readonly CatalogModel[], req: AutoRequest, plan: PlanId | null): CatalogModel[] {
  const models = 'models' in catalog ? catalog.models : catalog;
  return capableCandidates(models, { ...req, mature: true }, plan, (m) => !m.hidden && !m.requiresIdentitySafety && m.matureRouting === 'allowed');
}

/**
 * Animation step of a D-005 mature text-to-video chain: listed video models of
 * the mature family that take the request (image-to-video), including the
 * identity-driven spicy ones (`platform_assets_only`: the keyframe is a
 * platform picture), cheapest first. Face/head swap never qualifies; the
 * caller still checks `matureRunProblem` with the keyframe's provenance.
 */
export function chainVideoCandidates(catalog: Catalog | readonly CatalogModel[], req: AutoRequest, plan: PlanId | null): CatalogModel[] {
  const models = 'models' in catalog ? catalog.models : catalog;
  return capableCandidates(models, { ...req, mature: false }, plan, (m) => m.kind === 'video' && !m.hidden && !isSwapModel(m) && m.matureRouting !== 'never');
}

/** `bytedance/seedream-5.0-lite` → `bytedance/seedream`: the vendor and model family. */
export function modelFamily(id: string): string {
  const [vendor, name = ''] = id.split('/');
  return `${vendor}/${name.split('-')[0]}`;
}

/**
 * Fallbacks for an explicitly chosen model: capable siblings of the same family
 * (e.g. Seedream 5.0 Lite → Seedream 5.0 Flash / 5.5), cheapest first. Used only
 * after the chosen model keeps failing with transient errors, and only when the
 * sibling costs no more than what was held (checked at run time).
 */
export function familyFallbacks(catalog: Catalog | readonly CatalogModel[], chosen: CatalogModel, req: AutoRequest, plan: PlanId | null): CatalogModel[] {
  const models = 'models' in catalog ? catalog.models : catalog;
  const family = modelFamily(chosen.id);
  return capableCandidates(
    models,
    req,
    plan,
    (m) => m.id !== chosen.id && modelFamily(m.id) === family && m.kind === chosen.kind && !m.hidden && m.requiresIdentitySafety === chosen.requiresIdentitySafety,
  );
}

const TIMEOUT = Symbol('timeout');

/** Picks a model for an Auto request. Returns null when no candidate fits. */
export async function chooseModel(input: ChooseModelInput): Promise<ChooseModelResult | null> {
  const { request, candidates } = input;
  if (candidates.length === 0) return null;
  // Candidates are already capable and fitted per model; the cheapest is first.
  const fallback = candidates[0]!;
  const others = (chosen: CatalogModel) => candidates.filter((c) => c.id !== chosen.id);
  if (candidates.length === 1) return { model: candidates[0]!, via: 'single', fallbacks: [] };
  if (!input.classify) return { model: fallback, via: 'fallback', fallbacks: others(fallback), fallbackReason: 'error' };

  const ids = candidates.map((c) => c.id) as [string, ...string[]];
  const schema = z.object({ modelId: z.enum(ids) });
  const classifyInput: ClassifyInput = {
    prompt: request.prompt.slice(0, 2000),
    kind: request.kind,
    mode: request.mode,
    ...(request.seconds !== undefined && { seconds: request.seconds }),
    ...(request.resolution !== undefined && { resolution: request.resolution }),
    ...(request.ratio !== undefined && { ratio: request.ratio }),
    ...(request.audio !== undefined && { audio: request.audio }),
    references: (request.referenceImages ?? 0) + (request.inputImages ?? 0) + (request.referenceVideos ?? 0),
    candidates: candidates.map((m) => ({ id: m.id, name: m.displayName, tags: m.tags, usd: priceOf(m, fitRequest(m, request)) ?? 0, default: m.default })),
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), input.timeoutMs ?? AUTO_CLASSIFIER_TIMEOUT_MS);
  });
  let answer: unknown;
  try {
    answer = await Promise.race([input.classify(classifyInput, controller.signal), timeout]);
  } catch {
    return { model: fallback, via: 'fallback', fallbacks: others(fallback), fallbackReason: 'error' };
  } finally {
    clearTimeout(timer);
  }
  if (answer === TIMEOUT) {
    controller.abort();
    return { model: fallback, via: 'fallback', fallbacks: others(fallback), fallbackReason: 'timeout' };
  }
  let value: unknown = answer;
  if (typeof answer === 'string') {
    try {
      value = JSON.parse(answer);
    } catch {
      value = { modelId: answer.trim() };
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { model: fallback, via: 'fallback', fallbacks: others(fallback), fallbackReason: 'invalid' };
  const model = candidates.find((c) => c.id === parsed.data.modelId)!;
  return { model, via: 'classifier', fallbacks: others(model) };
}

const SYSTEM_PROMPT = [
  'You choose the generation model for a creative request in a video studio.',
  'Pick exactly one model id from the candidate list. Prefer the cheapest model that will do the request well;',
  'pay more only when the request clearly needs it (long or complex motion, people, text rendering, photorealism, 1080p+).',
  'Answer with JSON only: {"modelId": "<candidate id>"}.',
].join(' ');

/**
 * Classifier over the core chat adapter (DeepSeek V4.1 Flash, D-009). Collects
 * the streamed text and returns it; `chooseModel` parses and validates it.
 * `available` is the synced chat catalog (for the cheapest route).
 */
export function llmClassifier(llm: LlmProvider, available: Parameters<typeof resolveChatModel>[1], newKey: () => string): Classify {
  return async (input, signal) => {
    const model = resolveChatModel(AUTO_CLASSIFIER_CHAT_MODEL, available);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input) },
    ];
    let text = '';
    for await (const ev of llm.chat({
      model,
      messages,
      temperature: 0,
      maxTokens: 64,
      responseFormat: { type: 'json_object' },
      reasoningEffort: 'none',
      idempotencyKey: newKey(),
      signal,
    })) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'error') throw new Error(ev.error.code);
    }
    return text;
  };
}
