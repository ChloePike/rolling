/**
 * Free trial rules (D-022): what a trial workspace (no plan, trial credits)
 * may run, and the grant itself. Pure; CreditAccount applies `trialProblem`
 * on every quote it prices for a trial, and the UI uses the same rules to
 * show locked options before anything is quoted.
 */
import type { PriceRequest } from '../models/catalog';
import type { ListingModel } from '../models/types';
import { lowestPlanFor, PLAN_ORDER, resolutionRank, TRIAL, type PlanId } from './config';

const DAY_MS = 86_400_000;

/** Why a trial cannot run a request. `lowestPlan` is the plan that would (upgrade prompts). */
export type TrialLock =
  | { code: 'model'; lowestPlan: PlanId }
  | { code: 'resolution'; value: string; lowestPlan: PlanId }
  | { code: 'duration'; value: number; lowestPlan: PlanId }
  | { code: 'count'; value: number; lowestPlan: PlanId };

/** The trial's grant: fixed credits, expiring `TRIAL.days` after `now`. */
export function trialGrant(now: number): { credits: number; expiresAt: number } {
  if (!Number.isFinite(now) || now < 0) throw new RangeError('now must be a timestamp.');
  return { credits: TRIAL.credits, expiresAt: now + TRIAL.days * DAY_MS };
}

/** The model is in the curated trial set for its kind. */
export function isTrialModel(modelId: string, kind?: 'image' | 'video'): boolean {
  const lists = kind ? [TRIAL.models[kind]] : [TRIAL.models.image, TRIAL.models.video];
  return lists.some((l) => (l as readonly string[]).includes(modelId));
}

/** Total pixels of a `WxH` size, or null when it is not one. */
function sizePixels(size: string | undefined): number | null {
  const m = size ? /^(\d{2,5})[x*](\d{2,5})$/i.exec(size) : null;
  return m ? Number(m[1]) * Number(m[2]) : null;
}

const FIRST_PLAN: PlanId = PLAN_ORDER[0]!;

/**
 * Null when a trial may run `request` on `model`, else why not. Checks the
 * curated model set, the resolution cap (images 2K, video 480p), video length
 * (5 s) and images per run. Unknown resolution labels are refused.
 */
export function trialProblem(model: Pick<ListingModel, 'id' | 'kind' | 'defaultResolution' | 'defaultSeconds' | 'seconds'>, request: PriceRequest = {}): TrialLock | null {
  if (model.kind !== 'image' && model.kind !== 'video') return { code: 'model', lowestPlan: FIRST_PLAN };
  if (!isTrialModel(model.id, model.kind)) return { code: 'model', lowestPlan: FIRST_PLAN };
  const resolution = request.resolution ?? model.defaultResolution;
  const cap = model.kind === 'video' ? TRIAL.maxVideoResolution : TRIAL.maxImageResolution;
  if (resolution && resolutionRank(resolution) > resolutionRank(cap)) {
    return { code: 'resolution', value: resolution, lowestPlan: lowestPlanFor(model.kind, resolution) ?? 'pro' };
  }
  if (model.kind === 'image') {
    const px = sizePixels(request.size);
    if (request.size !== undefined && (px === null || px > TRIAL.maxImagePixels)) {
      return { code: 'resolution', value: request.size, lowestPlan: FIRST_PLAN };
    }
    const n = request.n ?? 1;
    if (n > TRIAL.maxImagesPerRun) return { code: 'count', value: n, lowestPlan: FIRST_PLAN };
    return null;
  }
  const seconds = request.seconds ?? model.defaultSeconds ?? model.seconds?.min;
  if (seconds !== undefined && seconds > TRIAL.maxVideoSeconds) return { code: 'duration', value: seconds, lowestPlan: FIRST_PLAN };
  return null;
}

/** Trial state of an account at `now`. */
export type TrialStatus = 'none' | 'active' | 'used' | 'expired';

export function trialStatus(t: { trial: number; trialExpiresAt: number | null; trialGrantedAt: number | null; trialHeld?: number }, now: number): TrialStatus {
  if (t.trialGrantedAt === null || t.trialExpiresAt === null) return 'none';
  if (now >= t.trialExpiresAt) return 'expired';
  if (t.trial <= 0 && !(t.trialHeld && t.trialHeld > 0)) return 'used';
  return 'active';
}
