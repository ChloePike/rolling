import { pickerModels, useModels, type CatalogModel } from '@/lib/models';
import { isMockApi } from '@/lib/api/mode';
import { toolModels, type ToolModel } from './models';
import type { PickerKind } from '../types';

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-plum)', 'var(--c-tone-sand)', 'var(--c-tone-teal)'];

function mark(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  const letters = words.map((w) => (/^\d/.test(w) ? w.replace(/\D/g, '').slice(0, 1) : w[0]!.toUpperCase())).join('');
  return letters.slice(0, 3) || name.slice(0, 2).toUpperCase();
}

/** Indicative credits per 5s (video) or per image from the catalog samples, for the picker rows only (runs use the quote). */
function unitCredits(m: CatalogModel): number {
  const res = m.defaultResolution;
  const points = m.credits.filter((p) => p.resolution === null || p.resolution === res);
  const pick = points.find((p) => p.seconds === 5) ?? points.find((p) => p.seconds === null) ?? points[0] ?? m.credits[0];
  if (!pick) return 0;
  return pick.seconds && pick.seconds !== 5 ? Math.ceil((pick.credits * 5) / pick.seconds) : pick.credits;
}

/**
 * Catalog models for a tool: video and image pickers drop hidden, tool-only and
 * mature-only models (D-009, D-005); Avatar lists the lip-sync models.
 */
export function fromCatalog(list: CatalogModel[], kind: PickerKind): ToolModel[] {
  const wanted =
    kind === 'avatar'
      ? list.filter((m) => m.kind === 'video' && m.lipSync && m.hidden !== true && !m.matureOnly)
      : pickerModels(list).filter((m) => m.kind === kind && !m.matureOnly && !m.lipSync);
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
    catalog: m,
  }));
}

/**
 * Models for a tool picker and its Advanced "Model" control, from the synced
 * catalog (`useModels`, lib/models). Real mode never shows anything else (an
 * empty list until the catalog answers); mock mode falls back to the approved
 * screens' list. `override` injects a list (tests, stories).
 */
export function useToolModels(kind: PickerKind, override?: ToolModel[], needs?: (m: CatalogModel) => boolean): ToolModel[] {
  const q = useModels(kind === 'image' ? 'image' : 'video');
  if (override) return override;
  const all = q.data ? fromCatalog(q.data, kind) : [];
  const live = needs ? all.filter((m) => !m.catalog || needs(m.catalog)) : all;
  return live.length || !isMockApi() ? live : toolModels[kind];
}

/** What each tool needs from a model (catalog `operations`, D-009 curated placement aside). */
export const TOOL_NEEDS = {
  /** Quick Create: text or reference video. */
  quick: (m: CatalogModel) => m.operations.includes('t2v') || m.operations.includes('refs'),
  /** Remix: reference inputs (the clip, new looks); first-frame models stand in with the clip's frame (core planRemix). */
  remix: (m: CatalogModel) => m.operations.includes('refs') || m.operations.includes('i2v'),
  /** Characters: text to image. */
  character: (m: CatalogModel) => m.operations.length === 0 || m.operations.includes('t2i'),
} as const;

/** Most chips the Advanced "Model" control shows (the designs show two or three). */
const SEG_MAX = 3;

/**
 * Options for the Advanced "Model" control. Catalog models: the curated
 * featured ones that fit the tool (display names from the catalog), at most
 * three. The mock list (mock mode): the design's short list by id.
 */
export function segModels(models: ToolModel[], mockIds: readonly string[] = []): ToolModel[] {
  const usable = models.filter((m) => !m.disabled);
  if (usable.some((m) => m.catalog)) {
    const featured = usable.filter((m) => (m.catalog?.placement ?? 'featured') === 'featured');
    return (featured.length ? featured : usable).slice(0, SEG_MAX);
  }
  const picked = mockIds.map((id) => usable.find((m) => m.id === id)).filter((m): m is ToolModel => !!m);
  return picked.length ? picked : usable;
}

/** The run request's model: a catalog id, or `auto`. */
export function modelIdOf(models: ToolModel[], selected: string): string {
  return selected === 'Auto' ? 'auto' : (models.find((m) => m.name === selected)?.id ?? 'auto');
}
