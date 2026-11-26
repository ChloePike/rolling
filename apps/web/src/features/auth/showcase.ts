import { api } from '@/lib/api/client';
import { isMockApi } from '@/lib/api/mode';

/** A clip of `GET /api/showcase` (built-in template previews on the public media host, never mature). */
export interface ShowcaseItem {
  id: string;
  name: string;
  /** The `<video poster>`: WebP, else JPEG. */
  posterUrl: string;
  poster: { avif: string | null; webp: string | null; jpg: string };
  previewUrl: string;
  /** CSS aspect-ratio, e.g. `9/16`. */
  aspect: string;
  width: number;
  height: number;
  color: string | null;
}

/** Each tile shows one clip; one tile changes every `ROTATE_MS`, round-robin, so no two change together. */
export const ROTATE_MS = 6000;
/** Crossfade length; the outgoing clip is dropped after it. */
export const FADE_MS = 600;

/**
 * The panel's clips. Never throws: a failed request is an empty list, and the
 * panel keeps its tone tiles. Mock mode has no clips (the design's tone tiles).
 */
export async function fetchShowcase(): Promise<ShowcaseItem[]> {
  if (isMockApi()) return [];
  try {
    const r = await api.get<{ items?: ShowcaseItem[] }>('/showcase', { noWorkspace: true });
    return (r.items ?? []).filter((i) => i && typeof i.previewUrl === 'string' && typeof i.posterUrl === 'string');
  } catch {
    return [];
  }
}

/** Reduced motion or data saver: posters only, no autoplay, no rotation. */
export function showcaseMotionAllowed(win: Window = window): boolean {
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  if (win.matchMedia?.('(prefers-reduced-data: reduce)').matches) return false;
  const conn = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

/**
 * The next clip to show: the first after `cursor` (wrapping) that no tile shows,
 * or null when every clip is already on screen.
 */
export function nextUnused(count: number, shown: readonly number[], cursor: number): number | null {
  for (let step = 0; step < count; step++) {
    const i = (cursor + step) % count;
    if (!shown.includes(i)) return i;
  }
  return null;
}
