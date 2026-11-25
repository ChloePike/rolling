import { useModels, type CatalogModel } from '@/lib/models';
import { toolModels, type ToolModel } from './models';
import type { PickerKind } from '../types';

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-plum)', 'var(--c-tone-sand)', 'var(--c-tone-teal)'];

function mark(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  const letters = words.map((w) => (/^\d/.test(w) ? w.replace(/\D/g, '').slice(0, 1) : w[0]!.toUpperCase())).join('');
  return letters.slice(0, 3) || name.slice(0, 2).toUpperCase();
}

/** Credits per 5s (video) or per image, from the catalog's price points at the default resolution. */
function unitCredits(m: CatalogModel): number {
  const res = m.defaultResolution;
  const points = m.credits.filter((p) => p.resolution === null || p.resolution === res);
  const pick = points.find((p) => p.seconds === 5) ?? points.find((p) => p.seconds === null) ?? points[0] ?? m.credits[0];
  if (!pick) return 0;
  return pick.seconds && pick.seconds !== 5 ? Math.ceil((pick.credits * 5) / pick.seconds) : pick.credits;
}

export function fromCatalog(list: CatalogModel[], kind: PickerKind): ToolModel[] {
  const wanted = kind === 'avatar' ? list.filter((m) => m.lipSync) : list.filter((m) => m.kind === kind && !m.matureOnly);
  return wanted.map((m, i) => ({
    id: m.id,
    name: m.name,
    mark: mark(m.name),
    tone: TONES[i % TONES.length]!,
    tags: m.tags,
    credits: unitCredits(m),
    unit: kind === 'image' ? 'perImage' : 'per5s',
    eta: '',
    points: m.credits,
    isDefault: m.default,
  }));
}

/**
 * Models for a tool picker and its Advanced "Model" control. Reads the synced
 * catalog through `useModels` (lib/models); until it has answered (or when the
 * API is unreachable, as in the design checks) the screen shows the mock list
 * from the approved designs. `override` injects a list (tests, stories).
 */
export function useToolModels(kind: PickerKind, override?: ToolModel[]): ToolModel[] {
  const q = useModels(kind === 'image' ? 'image' : 'video');
  if (override) return override;
  const live = q.data ? fromCatalog(q.data, kind) : [];
  return live.length ? live : toolModels[kind];
}

/**
 * Credits for one run from the catalog price points (`credits per resolution/seconds`).
 * Returns undefined when the list has no price data (mock list), so the caller
 * keeps its mock estimate.
 */
export function quoteCredits(models: ToolModel[], selected: string, opts: { resolution?: string; seconds?: number; count?: number }): number | undefined {
  const model = selected === 'Auto' ? (models.find((m) => m.isDefault) ?? models[0]) : models.find((m) => m.name === selected);
  const points = model?.points;
  if (!points?.length) return undefined;
  const match =
    points.find((p) => (p.resolution ?? null) === (opts.resolution ?? null) && (p.seconds ?? null) === (opts.seconds ?? null)) ??
    points.find((p) => p.resolution === (opts.resolution ?? null) || p.resolution === null);
  if (!match) return undefined;
  const perSecond = match.seconds && opts.seconds && match.seconds !== opts.seconds ? match.credits / match.seconds : undefined;
  const one = perSecond !== undefined ? Math.ceil(perSecond * opts.seconds!) : match.credits;
  return one * (opts.count ?? 1);
}

/** Options for the Advanced "Model" control: the design's short list when the catalog has it, else every model. */
export function segModels(models: ToolModel[], preferredIds: string[]): ToolModel[] {
  const picked = preferredIds.map((id) => models.find((m) => m.id === id)).filter((m): m is ToolModel => !!m);
  return picked.length ? picked : models.filter((m) => !m.disabled);
}
