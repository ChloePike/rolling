import type { CatalogModel } from '@/lib/models';
import type { ModelBadge, ModelKind, ModelOption } from './types';

/** Tile tones from ModelPicker.dc.html, assigned in list order. */
const TONES = ['#202330', '#26232A', '#28251F', '#1F2628'];
const BADGES: ReadonlySet<string> = new Set(['popular', 'new', 'budget', 'pro', 'comingSoon']);

function mark(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 .]/g, ' ').split(/\s+/).filter(Boolean);
  const caps = words.map((w) => w[0]!.toUpperCase()).join('');
  return (caps.length >= 2 ? caps : name.slice(0, 2).toUpperCase()).slice(0, 3);
}

/**
 * Credits for one quote unit: per 5s at the default resolution for video,
 * per 10s for lip-sync, per image for images. Uses the exact catalog point when
 * present, otherwise scales the closest per-second point linearly.
 */
export function unitCredits(m: CatalogModel, seconds: number | null): number {
  const atRes = m.credits.filter((c) => c.resolution === m.defaultResolution || c.resolution === null);
  const points = atRes.length ? atRes : m.credits;
  if (!points.length) return 0;
  if (seconds === null) return points[0]!.credits;
  const exact = points.find((c) => c.seconds === seconds);
  if (exact) return exact.credits;
  const withSecs = points.filter((c) => c.seconds);
  if (!withSecs.length) return points[0]!.credits;
  const near = withSecs.reduce((a, b) => (Math.abs((b.seconds ?? 0) - seconds) < Math.abs((a.seconds ?? 0) - seconds) ? b : a));
  return Math.ceil((near.credits / (near.seconds ?? seconds)) * seconds);
}

/** Maps the synced catalog (useModels) to picker rows for one picker kind. */
export function catalogToOptions(models: CatalogModel[], kind: ModelKind, opts: { showMature?: boolean } = {}): ModelOption[] {
  const list = models.filter((m) => {
    if (m.matureOnly && !opts.showMature) return false;
    if (m.hidden === true) return false;
    if (kind === 'avatar') return m.kind === 'video' && m.lipSync;
    // Tool-only models (swaps, motion transfer, LoRA) never appear in general pickers.
    if ((m.placement ?? 'featured') === 'tool') return false;
    if (kind === 'image') return m.kind === 'image';
    return m.kind === 'video' && !m.lipSync;
  });
  return list.map((m, i) => {
    const badge = typeof m.badge === 'string' && BADGES.has(m.badge) ? (m.badge as ModelBadge) : m.default ? 'popular' : undefined;
    const unit = kind === 'image' ? 'perImage' : kind === 'avatar' ? 'per10s' : 'per5s';
    return {
      id: m.id,
      name: m.name,
      mark: typeof m.mark === 'string' ? m.mark : mark(m.name),
      tone: typeof m.tone === 'string' ? m.tone : TONES[i % TONES.length]!,
      tags: m.tags,
      credits: unitCredits(m, unit === 'perImage' ? null : unit === 'per10s' ? 10 : 5),
      unit,
      eta: typeof m.eta === 'string' ? m.eta : '',
      badge,
      more: kind !== 'avatar' && m.placement === 'more',
      disabled: m.disabled === true,
      disabledReason: typeof m.disabledReason === 'string' ? m.disabledReason : undefined,
    } satisfies ModelOption;
  });
}
