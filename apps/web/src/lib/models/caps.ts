import type { CatalogModel } from './index';

/**
 * What a model can do with generation settings (ratio, resolution, length,
 * audio, count), from the synced catalog (`GET /api/models`, D-002):
 * `seconds`, `resolutions`, `ratios`, `audio`, `limits.imagesPerRequest`.
 * Shared by the tool pages (features/tools/shared/settings.ts), the Home
 * prompt box and the canvas prompt panel, so every settings popover offers
 * exactly the selected model's options and refits a value it lacks.
 */
export type SettingsKind = 'video' | 'image' | 'avatar';

export interface ToolSettings {
  /** e.g. `9:16`; empty when the model takes no ratio. */
  ratio: string;
  /** e.g. `720p` or `2K`; empty when the model takes no resolution. */
  resolution: string;
  /** Video length; 0 when the model takes none (images, avatar: the voice track sets it). */
  seconds: number;
  audio: boolean;
  /** Outputs per run (images only; the run API has no video count). */
  count: number;
}

export interface ToolCaps {
  /** Ratios to offer; empty hides the ratio pill and group. */
  ratios: string[];
  /** Resolutions to offer (locked above the plan's cap, D-006); empty hides them. */
  resolutions: string[];
  /** Lengths in seconds; empty hides duration. */
  durations: number[];
  /** The model generates audio: shows the audio switch and pill. */
  audio: boolean;
  /** Counts to offer; one or none hides the count group and pill. */
  counts: number[];
  /**
   * The design's sample model (mock list, no catalog entry): the approved
   * screens' extra controls (motion, frame rate, weights…) are drawn. Catalog
   * models expose no such parameters, so real mode never shows them.
   */
  design: boolean;
}

/** No options at all (real mode before the catalog answers). */
export const NO_CAPS: ToolCaps = { ratios: [], resolutions: [], durations: [], audio: false, counts: [], design: false };

const DURATION_STEPS = [5, 10, 15, 20, 30];
const COUNT_STEPS = [1, 2, 4];
const SIZE_STEPS = ['1K', '2K', '4K'];

/** Lengths a video model accepts: its `allowed` list, else the usual steps inside `min..max`. */
export function durationsOf(model: Pick<CatalogModel, 'seconds' | 'defaultSeconds'>): number[] {
  const s = model.seconds as (CatalogModel['seconds'] & { allowed?: number[] | null }) | null;
  if (!s) return [];
  if (s.allowed?.length) return [...s.allowed].sort((a, b) => a - b);
  const steps = DURATION_STEPS.filter((n) => n >= s.min && n <= s.max);
  if (steps.length) return steps;
  const one = model.defaultSeconds ?? s.min;
  return one > 0 ? [one] : [];
}

/** What the catalog says a model can do, for one tool kind. */
export function capsOf(model: CatalogModel | undefined, kind: SettingsKind): ToolCaps {
  if (!model) return NO_CAPS;
  const limits = model.limits as { imagesPerRequest?: number } | undefined;
  if (kind === 'image') {
    // Size-priced image models list no resolutions; they take the 1K/2K/4K labels (core `imageSizeFor`).
    const params = model.params as { size?: boolean } | undefined;
    const resolutions = model.resolutions.length ? model.resolutions : params?.size ? SIZE_STEPS : [];
    const max = limits?.imagesPerRequest ?? 1;
    return { ratios: model.ratios, resolutions, durations: [], audio: false, counts: COUNT_STEPS.filter((n) => n <= max), design: false };
  }
  return {
    ratios: model.ratios,
    resolutions: model.resolutions,
    // Avatar runs last as long as the voice track.
    durations: kind === 'avatar' ? [] : durationsOf(model),
    audio: kind === 'video' && model.audio,
    counts: [],
    design: false,
  };
}

function nearest(list: number[], want: number): number {
  return list.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

/**
 * Keeps `s` inside what the model can do: an unsupported ratio, resolution,
 * length or count falls back to the model's default (or the closest option).
 */
export function fitSettings(s: ToolSettings, caps: ToolCaps, model?: CatalogModel): ToolSettings {
  const pick = (value: string, list: string[], fallback?: string | null) =>
    list.length === 0 ? '' : list.includes(value) ? value : fallback && list.includes(fallback) ? fallback : list[0]!;
  return {
    ratio: pick(s.ratio, caps.ratios),
    resolution: pick(s.resolution, caps.resolutions, model?.defaultResolution),
    seconds: caps.durations.length === 0 ? 0 : caps.durations.includes(s.seconds) ? s.seconds : nearest(caps.durations, s.seconds || (model?.defaultSeconds ?? caps.durations[0]!)),
    audio: caps.audio ? s.audio : false,
    // An unsupported count refits to the closest one the model takes (Seedream 5.0 Flash: 1).
    count: caps.counts.length === 0 ? 1 : caps.counts.includes(s.count) ? s.count : nearest(caps.counts, s.count || 1),
  };
}

/** A model's own defaults inside its caps (`defaultResolution`, `defaultSeconds`, the first ratio). */
export function defaultSettings(caps: ToolCaps, model?: CatalogModel, seed: Partial<ToolSettings> = {}): ToolSettings {
  return fitSettings(
    {
      ratio: seed.ratio ?? caps.ratios.find((r) => r !== 'Auto') ?? '',
      resolution: seed.resolution ?? model?.defaultResolution ?? '',
      seconds: seed.seconds ?? model?.defaultSeconds ?? 0,
      audio: seed.audio ?? caps.audio,
      count: seed.count ?? 1,
    },
    caps,
    model,
  );
}

