import { lowestPlanFor, PLAN_ORDER, resolutionRank, type PlanId } from '@rolling/core/pricing/config';
import { useMemo } from 'react';
import { pickerModels, useModels, type CatalogModel } from '@/lib/models';
import { ratesFrom, type Rates } from './equivalents';

/** Shot and image equivalents from the synced catalog (falls back to the D-006 example). */
export function useRates(): Rates {
  const video = useModels('video');
  const image = useModels('image');
  return useMemo(() => ratesFrom(video.data, image.data), [video.data, image.data]);
}

/** Featured models also shown on the plans page although they sit behind "More models": they are why Plus exists for some users. */
export const PLAN_ROW_EXTRAS = ['lumina/berry-1.0-pro'];

/** Featured video and image models (D-009 curated list) plus `PLAN_ROW_EXTRAS`, for the "models by plan" row. Never mature (public page). */
export function useFeaturedModels(): CatalogModel[] {
  const video = useModels('video');
  const image = useModels('image');
  return useMemo(() => {
    const featured = [...pickerModels(video.data, { featuredOnly: true }), ...pickerModels(image.data, { featuredOnly: true })];
    const extras = pickerModels(video.data).filter((m) => PLAN_ROW_EXTRAS.includes(m.id) && !featured.some((f) => f.id === m.id));
    return [...featured, ...extras].filter((m) => !m.matureOnly && !m.mature);
  }, [video.data, image.data]);
}

/**
 * The lowest plan that can use a model at all (D-006 caps): its smallest
 * resolution must fit the plan's cap. MiniMax H3 (768p minimum) and Wan 3.0 Pro
 * (1080p minimum) need Plus; most models run on Starter at 720p.
 */
export function lowestPlanForModel(m: { kind: string; resolutions?: string[]; defaultResolution?: string | null }): PlanId | null {
  const kind = m.kind === 'image' ? 'image' : 'video';
  const list = (m.resolutions?.length ? m.resolutions : m.defaultResolution ? [m.defaultResolution] : []).filter(Boolean);
  if (!list.length) return PLAN_ORDER[0]!;
  const min = [...list].sort((a, b) => resolutionRank(a) - resolutionRank(b))[0]!;
  return lowestPlanFor(kind, min);
}
