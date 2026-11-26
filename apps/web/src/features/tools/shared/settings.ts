import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel } from '@/lib/models';
import { capsOf, defaultSettings, fitSettings, NO_CAPS, type SettingsKind, type ToolCaps, type ToolSettings } from '@/lib/models/caps';

export { capsOf, defaultSettings, durationsOf, fitSettings, NO_CAPS, type SettingsKind, type ToolCaps, type ToolSettings } from '@/lib/models/caps';
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
/**
 * Options of the approved designs (ParamPopover.dc.html). Used only when a
 * model has no catalog entry, i.e. the mock model list in mock mode.
 */
export const DESIGN_CAPS: Record<SettingsKind, ToolCaps> = {
  video: { ratios: ['Auto', '9:16', '16:9', '1:1', '4:3', '3:4'], resolutions: ['480p', '720p', '1080p'], durations: [5, 10, 15], audio: true, counts: [1, 2, 4], design: true },
  avatar: { ratios: ['9:16', '16:9', '1:1'], resolutions: ['480p', '720p', '1080p'], durations: [], audio: false, counts: [], design: true },
  image: { ratios: ['Auto', '9:16', '16:9', '1:1', '4:3', '3:4'], resolutions: ['1K', '2K', '4K'], durations: [], audio: false, counts: [1, 2, 4], design: true },
};

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
