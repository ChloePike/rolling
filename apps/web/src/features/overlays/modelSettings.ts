import type { PlanId } from '@rolling/core/pricing/config';
import type { IntlShape } from 'react-intl';
import type { CatalogModel } from '@/lib/models';
import { capsOf, fitSettings, type SettingsKind, type ToolCaps, type ToolSettings } from '@/lib/models/caps';
import { planLockInfo } from './PlanLock';
import type { ParamOptions } from './ParamPopover';
import type { ImageParams, VideoAspect, VideoParams } from './types';

/**
 * Prompt-box settings (Home, the canvas prompt panel) from the selected model's
 * capabilities (PROMPT-2), with the same rules as the tool pages
 * (`@/lib/models/caps`): options come from the catalog, not the mode; an
 * unsupported value refits to the closest supported one; plan locks still
 * apply; the cost line shows a reason instead of a number when it cannot quote.
 */
export function modelCaps(model: CatalogModel | undefined, kind: SettingsKind): ToolCaps | null {
  return model ? capsOf(model, kind) : null;
}

/** ParamPopover options for these caps (an empty list hides a setting; one count hides the count group). */
export function paramOptions(caps: ToolCaps | null): ParamOptions | undefined {
  if (!caps) return undefined;
  return {
    ratios: caps.ratios,
    resolutions: caps.resolutions,
    durations: caps.durations.map((n) => `${n}s`),
    counts: caps.counts.length > 1 ? caps.counts.map(String) : null,
    quality: false,
  };
}

export const videoToSettings = (v: VideoParams): ToolSettings => ({ ratio: v.aspectRatio, resolution: v.resolution, seconds: parseInt(v.duration, 10) || 0, audio: v.audio, count: Number(v.count) || 1 });
export const imageToSettings = (v: ImageParams): ToolSettings => ({ ratio: v.aspectRatio, resolution: v.size, seconds: 0, audio: false, count: Number(v.count) || 1 });

/** Video params fitted to the model; unchanged (same object) when they already fit. */
export function fitVideo(v: VideoParams, caps: ToolCaps | null, model?: CatalogModel): VideoParams {
  if (!caps) return v;
  const f = fitSettings(videoToSettings(v), caps, model);
  const next: VideoParams = {
    aspectRatio: (f.ratio || v.aspectRatio) as VideoAspect,
    resolution: (f.resolution || v.resolution) as VideoParams['resolution'],
    duration: (f.seconds ? `${f.seconds}s` : v.duration) as VideoParams['duration'],
    count: (caps.counts.length ? String(f.count) : v.count) as VideoParams['count'],
    audio: caps.audio ? v.audio : false,
  };
  return JSON.stringify(next) === JSON.stringify(v) ? v : next;
}

/** Image params fitted to the model (count defaults to what it supports: Seedream 5.0 Flash = 1). */
export function fitImage(v: ImageParams, caps: ToolCaps | null, model?: CatalogModel): ImageParams {
  if (!caps) return v;
  const f = fitSettings(imageToSettings(v), caps, model);
  const next: ImageParams = {
    ...v,
    aspectRatio: (f.ratio || v.aspectRatio) as VideoAspect,
    size: (f.resolution || v.size) as ImageParams['size'],
    count: String(caps.counts.length ? f.count : 1) as ImageParams['count'],
  };
  return JSON.stringify(next) === JSON.stringify(v) ? v : next;
}

/** Longest length the model takes (its catalog range), for the Duration note (“Max 12s on this model”). */
export function maxSeconds(caps: ToolCaps | null, model?: CatalogModel): number {
  if (!caps?.durations.length) return 0;
  const s = model?.seconds as { max?: number; allowed?: number[] | null } | null | undefined;
  return s?.allowed?.length ? Math.max(...s.allowed) : (s?.max ?? Math.max(...caps.durations));
}

/**
 * Credits for one run from the catalog price points, without guessing: the exact
 * point, else the same resolution scaled by seconds; null when the model has no
 * price for these settings.
 */
export function strictCredits(model: CatalogModel, s: { resolution?: string | null; seconds?: number | null; count?: number }): number | null {
  const res = s.resolution || model.defaultResolution || null;
  const secs = s.seconds || model.defaultSeconds || null;
  const count = s.count ?? 1;
  const exact = model.credits.find((p) => (p.resolution ?? null) === res && (p.seconds ?? null) === secs) ?? (secs === null ? model.credits.find((p) => (p.resolution ?? null) === res) : undefined);
  if (exact) return exact.credits * count;
  const sameRes = model.credits.find((p) => (p.resolution ?? null) === res && p.seconds);
  if (sameRes && secs) return Math.ceil((sameRes.credits * secs) / sameRes.seconds!) * count;
  // Unpriced resolution on a model priced per run (images without per-size points).
  if (model.credits.length === 1 && (model.credits[0]!.resolution ?? null) === null) return model.credits[0]!.credits * count;
  return null;
}

/**
 * Why these settings cannot be quoted (the cost line shows it instead of a number), or null:
 * a resolution above the plan's cap (D-006), a value the model does not take, or no price.
 */
export function costBlock(intl: IntlShape, kind: 'video' | 'image', model: CatalogModel | undefined, caps: ToolCaps | null, s: ToolSettings, plan?: PlanId): string | null {
  if (!model || !caps) return null;
  if (plan && s.resolution) {
    const lock = planLockInfo(intl, plan, kind, s.resolution);
    if (lock) return intl.formatMessage({ id: 'overlays.cost.blocked.plan' }, { option: s.resolution, reason: lock.reason });
  }
  const off =
    (caps.resolutions.length > 0 && !caps.resolutions.includes(s.resolution)) ||
    (caps.durations.length > 0 && !caps.durations.includes(s.seconds)) ||
    (caps.ratios.length > 0 && s.ratio !== '' && !caps.ratios.includes(s.ratio)) ||
    (caps.counts.length > 0 && !caps.counts.includes(s.count));
  if (off) return intl.formatMessage({ id: 'overlays.cost.blocked.unsupported' }, { model: model.name });
  if (strictCredits(model, { resolution: s.resolution, seconds: s.seconds, count: s.count }) === null) return intl.formatMessage({ id: 'overlays.cost.blocked.unpriced' });
  return null;
}
