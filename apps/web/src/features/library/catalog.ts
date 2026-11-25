import {
  LIBRARY_CATEGORIES,
  LIBRARY_GROUPS,
  type LibraryCategory,
} from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';

/** Glyphs from PublicLibrary.dc.html, drawn behind thumbnails (and alone when an item has none). */
const IC = {
  pose: 'M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M12 6v7 M8 9l4 1 4-3 M12 13l-3 8 M12 13l3 8',
  wear: 'M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z',
  face: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01',
  user: 'M18 20a6 6 0 0 0-12 0 M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  hair: 'M4 20c0-9 3-16 8-16s8 7 8 16 M8 20c0-6 1.5-10 4-10s4 4 4 10',
  scene: 'M8 3l4 8 5-5 5 15H2L8 3z',
  light: 'M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
  prop: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7l8.7 5 8.7-5 M12 22V12',
  sofa: 'M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3 M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z M4 18v2 M20 18v2',
  robe: 'M12 3 6 6l-2 15h16l-2-15-6-3z M12 3v18 M9 10h6',
};

export interface CategoryView {
  key: LibraryCategoryKey;
  def: LibraryCategory;
  glyph: string;
  /** Card thumbnail aspect ratio. */
  ar: string;
  /** Message id of the primary action in the details panel. */
  cta: string;
}

const VIEW: Record<LibraryCategoryKey, { glyph: string; ar: string; cta: string }> = {
  pose: { glyph: IC.pose, ar: '3/4', cta: 'pose' },
  pose_depth: { glyph: IC.pose, ar: '3/4', cta: 'pose' },
  portrait: { glyph: IC.user, ar: '1/1', cta: 'face' },
  expression: { glyph: IC.face, ar: '1/1', cta: 'expression' },
  hairstyle: { glyph: IC.hair, ar: '1/1', cta: 'hairstyle' },
  outfit: { glyph: IC.wear, ar: '3/4', cta: 'dress' },
  outfit_anime: { glyph: IC.wear, ar: '3/4', cta: 'dress' },
  outfit_historical: { glyph: IC.robe, ar: '3/4', cta: 'dress' },
  scene: { glyph: IC.scene, ar: '16/10', cta: 'setting' },
  lighting: { glyph: IC.light, ar: '16/10', cta: 'lighting' },
  prop: { glyph: IC.prop, ar: '1/1', cta: 'canvas' },
  furniture: { glyph: IC.sofa, ar: '1/1', cta: 'canvas' },
};

export function categoryView(def: LibraryCategory): CategoryView {
  const v = VIEW[def.key];
  return { key: def.key, def, glyph: v.glyph, ar: v.ar, cta: `library.public.cta.${v.cta}` };
}

export const ALL_CATEGORIES = LIBRARY_CATEGORIES.map(categoryView);

export interface CategoryGroupView {
  group: (typeof LIBRARY_GROUPS)[number];
  categories: CategoryView[];
}

/**
 * Groups and categories in registry order. With server counts (`publicCategories`),
 * categories without items are hidden (hairstyles: CharaDB images are excluded
 * from R2, D-004); before the counts arrive every category is listed.
 */
export function categoryGroups(counts: ReadonlyMap<string, number> | null): CategoryGroupView[] {
  return LIBRARY_GROUPS.map((g) => ({
    group: g,
    categories: ALL_CATEGORIES.filter((c) => c.def.group === g.key && (!counts || (counts.get(c.key) ?? 0) > 0)),
  })).filter((g) => g.categories.length > 0);
}

export function findCategory(key: string | undefined, groups: CategoryGroupView[]): CategoryView {
  const visible = groups.flatMap((g) => g.categories);
  return visible.find((c) => c.key === key) ?? ALL_CATEGORIES.find((c) => c.key === key) ?? visible[0] ?? ALL_CATEGORIES[0]!;
}

/** License chip colors from PublicLibrary.dc.html. First-party items carry no label (D-004). */
export const LICENSE_CHIP: Record<'cc0' | 'mit', { bg: string; fg: string }> = {
  cc0: { bg: 'rgba(34,197,94,.12)', fg: '#4ADE80' },
  mit: { bg: 'rgba(59,130,246,.14)', fg: '#93C5FD' },
};

export { shortId } from '@/lib/publicLibrary';
