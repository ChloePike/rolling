/**
 * Model checks for proposals: capabilities from the synced catalog, plan
 * resolution caps (D-006), mature routing (D-005) and credit estimates.
 */
import type { CatalogModel, GenerationMode, PriceRequest } from '@rolling/core';
import { lowestPlanFor, planAllowsResolution, type PlanId } from '@rolling/core/pricing/config';
import type { AccountSnapshot, ModelsPort } from './ports';

export interface GenSpec {
  kind: 'video' | 'image';
  model: string;
  mode: GenerationMode;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  count?: number;
  inputImages?: number;
}

/** UI labels some clients store in `params.mode`, mapped to catalog modes. */
const MODE_LABELS: Record<string, GenerationMode> = {
  'text to video': 't2v',
  'first frame': 'i2v',
  'image to video': 'i2v',
  'first and last frame': 'first_last_frame',
  'first + last frame': 'first_last_frame',
  references: 'refs',
  'reference media': 'refs',
  extend: 'extend',
  'text to image': 't2i',
  'image to image': 'edit',
  edit: 'edit',
};

const KNOWN_MODES = new Set<string>(['t2v', 'i2v', 'first_last_frame', 'refs', 'extend', 't2i', 'edit', 'face_swap', 'head_swap', 'motion_transfer', 'lip_sync']);

export function normalizeMode(raw: unknown, fallback: GenerationMode): GenerationMode {
  if (typeof raw !== 'string' || !raw) return fallback;
  if (KNOWN_MODES.has(raw)) return raw as GenerationMode;
  return MODE_LABELS[raw.toLowerCase()] ?? (raw as GenerationMode);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?s?$/.test(v)) return Number.parseFloat(v);
  return undefined;
}

/**
 * Generation spec of a video or image node from its params. `hasFrame` /
 * `hasRefs` say whether image inputs are wired, to infer the mode.
 */
export function specFromParams(
  kind: 'video' | 'image',
  params: Record<string, unknown>,
  inputs: { frames: number; refs: number } = { frames: 0, refs: 0 },
): GenSpec | null {
  const model = typeof params.model === 'string' ? params.model : null;
  if (!model) return null;
  const fallback: GenerationMode = kind === 'video' ? (inputs.frames > 0 ? 'i2v' : 't2v') : inputs.refs > 0 ? 'edit' : 't2i';
  const spec: GenSpec = { kind, model, mode: normalizeMode(params.mode, fallback) };
  const seconds = num(params.seconds) ?? num(params.duration);
  if (kind === 'video' && seconds !== undefined) spec.seconds = seconds;
  if (typeof params.resolution === 'string') spec.resolution = params.resolution;
  if (typeof params.ratio === 'string') spec.ratio = params.ratio;
  if (typeof params.audio === 'boolean') spec.audio = params.audio;
  const count = num(params.count);
  if (kind === 'image' && count !== undefined) spec.count = Math.max(1, Math.round(count));
  const images = kind === 'video' ? inputs.frames : inputs.refs;
  if (images) spec.inputImages = images;
  return spec;
}

/** The resolution a request will use: its own, else the model default. */
export function effectiveResolution(model: CatalogModel, spec: Pick<GenSpec, 'resolution'>): string | undefined {
  return spec.resolution ?? model.defaultResolution ?? undefined;
}

/**
 * Problems with a spec, phrased for the model (it retries with them). Empty
 * when the spec is fine. Checks: model exists and is offered, kind, mode,
 * length, resolution offered by the model and allowed by the plan, ratio,
 * mature routing, identity-driven models.
 */
export function specProblems(spec: GenSpec, models: ModelsPort, account: Pick<AccountSnapshot, 'plan' | 'matureAllowed'>): string[] {
  const model = models.get(spec.model);
  if (!model || model.hidden) return [`model "${spec.model}" is not in the catalog; call models.capabilities`];
  const problems: string[] = [];
  if (model.kind !== spec.kind) problems.push(`${model.id} is a ${model.kind} model, not ${spec.kind}`);
  if (model.matureOnly && !account.matureAllowed) problems.push(`${model.id} is not available for this account`);
  if (model.requiresIdentitySafety || model.placement === 'tool') {
    problems.push(`${model.id} is a special-purpose model; pick a general ${spec.kind} model`);
  }
  if (!model.operations.includes(spec.mode)) {
    problems.push(`${model.id} does not support mode ${spec.mode} (supports ${model.operations.join(', ')})`);
  }
  if (spec.kind === 'video' && spec.seconds !== undefined) {
    const s = model.seconds;
    if (!s) problems.push(`${model.id} takes its length from an input clip`);
    else if (s.allowed ? !s.allowed.includes(spec.seconds) : spec.seconds < s.min || spec.seconds > s.max || !Number.isInteger(spec.seconds)) {
      problems.push(
        `${model.id} takes ${s.allowed ? `exactly ${s.allowed.join(' or ')}` : `whole seconds from ${s.min} to ${s.max}`} seconds, not ${spec.seconds}`,
      );
    }
  }
  const resolution = effectiveResolution(model, spec);
  if (spec.resolution !== undefined && model.resolutions.length && !model.resolutions.includes(spec.resolution)) {
    problems.push(`${model.id} offers ${model.resolutions.join(', ')}, not ${spec.resolution}`);
  } else if (resolution && account.plan && model.resolutions.length && !planAllowsResolution(account.plan, spec.kind, resolution)) {
    const allowed = model.resolutions.filter((r) => planAllowsResolution(account.plan!, spec.kind, r));
    problems.push(
      `${resolution} needs the ${lowestPlanFor(spec.kind, resolution) ?? 'higher'} plan; this plan allows ${allowed.length ? allowed.join(', ') : 'no resolution of this model'} on ${model.id}`,
    );
  }
  if (spec.ratio !== undefined && model.ratios.length && !model.ratios.includes(spec.ratio)) {
    problems.push(`${model.id} offers ratios ${model.ratios.join(', ')}, not ${spec.ratio}`);
  }
  if (spec.audio && !model.audio) problems.push(`${model.id} cannot make sound`);
  if (spec.kind === 'image' && (spec.count ?? 1) > model.maxImagesPerRequest) {
    problems.push(`${model.id} makes at most ${model.maxImagesPerRequest} images per run`);
  }
  return problems;
}

export function priceRequest(model: CatalogModel, spec: GenSpec): PriceRequest {
  const req: PriceRequest = {};
  const resolution = effectiveResolution(model, spec);
  if (resolution) req.resolution = resolution;
  if (spec.kind === 'video') req.seconds = spec.seconds ?? model.defaultSeconds ?? model.seconds?.min ?? 5;
  if (spec.audio !== undefined) req.audio = spec.audio;
  if (spec.kind === 'image' && spec.count) req.n = spec.count;
  if (spec.inputImages) req.inputImages = spec.inputImages;
  return req;
}

/** Credits for one spec, or null when it cannot be priced. */
export function creditsForSpec(spec: GenSpec, models: ModelsPort): number | null {
  const model = models.get(spec.model);
  if (!model) return null;
  return models.creditsFor(model, priceRequest(model, spec));
}

/** Highest resolution of a model the plan allows (for defaults), or the model default. */
export function bestAllowedResolution(model: CatalogModel, plan: PlanId | null, kind: 'video' | 'image', prefer?: string): string | undefined {
  if (!model.resolutions.length) return undefined;
  const ok = (r: string) => !plan || planAllowsResolution(plan, kind, r);
  if (prefer && model.resolutions.includes(prefer) && ok(prefer)) return prefer;
  if (model.defaultResolution && ok(model.defaultResolution)) return model.defaultResolution;
  return model.resolutions.find(ok);
}
