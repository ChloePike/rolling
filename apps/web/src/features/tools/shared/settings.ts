import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel } from '@/lib/models';
import type { ToolModel } from './models';

/**
 * Generation settings of a tool page (ratio, resolution, length, audio, count)
 * and what the selected model can do with them. Options and defaults come from
 * the synced catalog (`GET /api/models`, D-002): `seconds`, `resolutions`,
 * `ratios`, `audio`, `limits.imagesPerRequest`. "Auto" uses the catalog default
 * model's capabilities, the same model the quote starts from. Pills, the
 * settings popover, the run card tags and the run request all read one
 * `ToolSettings` value.
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

/**
 * Options of the approved designs (ParamPopover.dc.html). Used only when a
 * model has no catalog entry, i.e. the mock model list in mock mode.
 */
export const DESIGN_CAPS: Record<SettingsKind, ToolCaps> = {
  video: { ratios: ['Auto', '9:16', '16:9', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p', '1080p'], durations: [5, 10, 15], audio: true, counts: [1, 2, 4], design: true },
  avatar: { ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p', '1080p'], durations: [], audio: false, counts: [], design: true },
  image: { ratios: ['Auto', '9:16', '16:9', '1:1', '4:3', '3:4'], resolutions: ['1K', '2K', '4K'], durations: [], audio: false, counts: [1, 2, 4], design: true },
};

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

/** The tool's caps for the selected model ("Auto": the catalog default). */
export function toolCaps(models: ToolModel[], selected: string, kind: SettingsKind): ToolCaps {
  const m = selectedModel(models, selected);
  if (!m) return NO_CAPS;
  return m.catalog ? capsOf(m.catalog, kind) : DESIGN_CAPS[kind];
}

/** The model a selection stands for: by name, "Auto" → the catalog default (else the first). */
export function selectedModel(models: ToolModel[], selected: string): ToolModel | undefined {
  if (selected === 'Auto') return models.find((m) => m.isDefault) ?? models.find((m) => !m.disabled);
  return models.find((m) => m.name === selected);
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
    count: caps.counts.length === 0 ? 1 : caps.counts.includes(s.count) ? s.count : 1,
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

/**
 * One settings value for a tool page. `seed` is the page's starting point
 * (a template's ratio and length; in mock mode the design's values from the
 * mock adapter). Whenever the model (or the catalog) changes, the value is
 * fitted to the new caps so a pill never shows an option the model lacks.
 */
export function useToolSettings(models: ToolModel[], selected: string, kind: SettingsKind, seed: Partial<ToolSettings> = {}) {
  const caps = useMemo(() => toolCaps(models, selected, kind), [models, selected, kind]);
  const model = selectedModel(models, selected)?.catalog;
  const [value, setValue] = useState<ToolSettings>(() => defaultSettings(caps, model, seed));
  const capsKey = JSON.stringify(caps);
  useEffect(() => {
    setValue((cur) => {
      const next = fitSettings(cur.ratio || cur.resolution || cur.seconds ? cur : defaultSettings(caps, model, seed), caps, model);
      return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
    });
    // Refit on a new model or catalog only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capsKey, model?.id]);
  const seedKey = JSON.stringify(seed);
  useEffect(() => {
    if (!Object.keys(seed).length) return;
    setValue((cur) => fitSettings({ ...cur, ...seed }, caps, model));
    // A new seed (another template or ratio from the URL) restarts from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  const reset = () => setValue(defaultSettings(caps, model, seed));
  return { value, set: (next: ToolSettings) => setValue(fitSettings(next, caps, model)), caps, reset, model };
}
