import type { CatalogModel, CreditPoint } from '@/lib/models';

/**
 * What a number of credits buys, for the Upgrade page and the top-up
 * calculator ("≈ 2 Seedance 2.5 shots of 5s at 720p"). Rates come from the
 * synced catalog (`useModels`); until it answers, the video rate falls back to
 * the D-006 worked example (Seedance 2.5, 720p, 5s = 347 credits).
 */
export const REFERENCE_VIDEO = { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5', resolution: '720p', seconds: 5 } as const;
/** D-006: `ceil(5 × $0.23112 × 3.0 ÷ $0.01)`. */
export const REFERENCE_VIDEO_FALLBACK_CREDITS = 347;

/** Credits for one output at `resolution` and `seconds` from catalog price points; null when unpriced. */
export function creditsAt(points: readonly CreditPoint[], resolution: string | null, seconds: number | null): number | null {
  const exact = points.find((p) => (p.resolution ?? null) === resolution && (p.seconds ?? null) === seconds);
  if (exact) return exact.credits;
  if (seconds === null) {
    const any = points.find((p) => p.resolution === resolution || p.resolution === null);
    return any ? any.credits : null;
  }
  // Scale a price point at the same resolution by length (gateway prices are per second).
  const same = points.filter((p) => (p.resolution === resolution || p.resolution === null) && p.seconds);
  const base = same.find((p) => p.seconds === 5) ?? same[0];
  return base ? Math.ceil((base.credits / base.seconds!) * seconds) : null;
}

export interface Rates {
  video: { name: string; resolution: string; seconds: number; credits: number };
  /** The same model at 480p, for balances below one 720p shot (Starter). Null when unpriced. */
  video480: { name: string; resolution: string; seconds: number; credits: number } | null;
  /** Null when the catalog has no image price yet. */
  image: { name: string; resolution: string | null; credits: number } | null;
}

export function ratesFrom(video: readonly CatalogModel[] | undefined, image: readonly CatalogModel[] | undefined): Rates {
  const ref = video?.find((m) => m.id === REFERENCE_VIDEO.id);
  const credits = ref ? creditsAt(ref.credits, REFERENCE_VIDEO.resolution, REFERENCE_VIDEO.seconds) : null;
  const img = image?.find((m) => m.default && !m.matureOnly) ?? image?.find((m) => !m.matureOnly && m.credits.length > 0);
  const imgCredits = img ? creditsAt(img.credits, img.defaultResolution, null) : null;
  const low = ref ? creditsAt(ref.credits.filter((p) => p.resolution === LOW_RES), LOW_RES, REFERENCE_VIDEO.seconds) : null;
  const videoCredits = credits && credits > 0 ? credits : REFERENCE_VIDEO_FALLBACK_CREDITS;
  return {
    video: {
      name: ref?.name ?? REFERENCE_VIDEO.name,
      resolution: REFERENCE_VIDEO.resolution,
      seconds: REFERENCE_VIDEO.seconds,
      credits: videoCredits,
    },
    video480:
      low && low > 0
        ? { name: ref?.name ?? REFERENCE_VIDEO.name, resolution: LOW_RES, seconds: REFERENCE_VIDEO.seconds, credits: low }
        : // Without a catalog price, scale the 720p price by pixel area (854×480 vs 1280×720); only used when no image price exists either.
          !ref
          ? { name: REFERENCE_VIDEO.name, resolution: LOW_RES, seconds: REFERENCE_VIDEO.seconds, credits: Math.ceil(videoCredits * ((854 * 480) / (1280 * 720))) }
          : null,
    image: img && imgCredits && imgCredits > 0 ? { name: img.name, resolution: img.defaultResolution, credits: imgCredits } : null,
  };
}

const LOW_RES = '480p';

/**
 * What a balance buys, in a unit that is never zero: 720p shots when at least
 * one fits, else 480p shots, else images. Null only when nothing is priced.
 */
export type Equivalence =
  | { unit: 'shots'; n: number; rate: Rates['video']; images: number | null }
  | { unit: 'images'; n: number; model: string };

export function equivalentFor(credits: number, rates: Rates): Equivalence | null {
  const images = rates.image ? howMany(credits, rates.image.credits) : null;
  const shots = howMany(credits, rates.video.credits);
  if (shots >= 1) return { unit: 'shots', n: shots, rate: rates.video, images };
  if (rates.video480 && howMany(credits, rates.video480.credits) >= 1) return { unit: 'shots', n: howMany(credits, rates.video480.credits), rate: rates.video480, images };
  if (rates.image && images && images >= 1) return { unit: 'images', n: images, model: rates.image.name };
  return null;
}

/** Whole outputs a balance covers (never rounds up: credits are money). */
export function howMany(credits: number, perOutput: number): number {
  return perOutput > 0 ? Math.floor(credits / perOutput) : 0;
}

/** Seconds of reference video a balance covers, for balances below one shot. */
export function secondsOf(credits: number, rate: Rates['video']): number {
  return Math.floor((credits / rate.credits) * rate.seconds);
}
