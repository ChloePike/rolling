import type { CatalogModel } from '@/lib/models';
import type { ModelOption } from '@/features/overlays';

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-plum)', 'var(--c-tone-sand)', 'var(--c-tone-teal)', 'var(--c-tone-slate)', 'var(--c-tone-clay)'];

/**
 * Credits for one run of `model` from its catalog price points (D-002: credits
 * follow live cost per resolution and seconds). Picks the exact point, else the
 * same resolution scaled by seconds, else the cheapest point.
 */
export function quoteCredits(
  model: CatalogModel | undefined,
  opts: { resolution?: string | null; seconds?: number | null; count?: number } = {},
): number | null {
  if (!model || model.credits.length === 0) return null;
  const res = opts.resolution ?? model.defaultResolution;
  const secs = opts.seconds ?? model.defaultSeconds;
  const count = opts.count ?? 1;
  const exact = model.credits.find((p) => (p.resolution ?? null) === (res ?? null) && (p.seconds ?? null) === (secs ?? null));
  if (exact) return exact.credits * count;
  const sameRes = model.credits.find((p) => (p.resolution ?? null) === (res ?? null) && p.seconds);
  if (sameRes && secs) return Math.ceil((sameRes.credits * secs) / sameRes.seconds!) * count;
  return Math.min(...model.credits.map((p) => p.credits)) * count;
}

/** Catalog model → the overlay ModelPicker row (price per 5s for video, per image for images). */
export function toModelOption(m: CatalogModel, i: number): ModelOption {
  const isImage = m.kind === 'image';
  const credits = isImage ? (quoteCredits(m, { count: 1 }) ?? 0) : (quoteCredits(m, { seconds: 5 }) ?? 0);
  return {
    id: m.id,
    name: m.name,
    mark: m.name
      .split(/[\s.-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join(''),
    tone: TONES[i % TONES.length]!,
    tags: m.tags,
    credits,
    unit: isImage ? 'perImage' : 'per5s',
    eta: '',
    more: m.placement === 'more',
  };
}

/** The default model for a list: the catalog's default flag, else the first entry. */
export function defaultModel(list: CatalogModel[] | undefined): CatalogModel | undefined {
  return list?.find((m) => m.default) ?? list?.[0];
}
