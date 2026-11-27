import type { ToolCaps } from '@/lib/models/caps';
import type { ImageParams, VideoAspect } from '@/features/overlays/types';

/** Ratios the Home settings offer; the default aspect ratio preference applies when it is one of them. */
export const HOME_RATIOS: readonly VideoAspect[] = ['9:16', '16:9', '1:1', '4:3', '3:4'];

/**
 * Home Image starts from the Preferences default aspect ratio when Home offers
 * it (`fitImage` then refits it to the model, so a model that can't make it
 * gets the closest ratio it takes).
 */
export function seedImageRatio(v: ImageParams, prefRatio: string): ImageParams {
  return (HOME_RATIOS as readonly string[]).includes(prefRatio) ? { ...v, aspectRatio: prefRatio as VideoAspect } : v;
}

/**
 * The image settings popover would offer a choice for this model: more than
 * one ratio, size or count. Without one (e.g. Seedream 5.0 Flash: one 2K image,
 * sized from the ratio) the pills show the fixed values read-only and never
 * open an empty popover. Unknown caps (mock mode, the design's options) count as a choice.
 */
export function imageHasChoice(caps: ToolCaps | null): boolean {
  if (!caps) return true;
  return caps.ratios.length > 1 || caps.resolutions.length > 1 || caps.counts.length > 1;
}
