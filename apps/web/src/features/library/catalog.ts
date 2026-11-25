import {
  LIBRARY_CATEGORIES,
  LIBRARY_GROUPS,
  type LibraryCategory,
} from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';

/**
 * Sub-categories and item counts per category, in source order, as served by
 * the staging import (2026-11-25). `categories.ts` has no sub-category list
 * and the GraphQL API has no facet query yet; move this into
 * packages/core/src/library/categories.ts (or a `publicFacets` query) when one
 * exists. Categories with no items (hairstyles: CharaDB images are excluded
 * from R2, D-004) are hidden.
 */
export const CATALOG: Record<LibraryCategoryKey, { count: number; subs: Array<[slug: string, count: number]> }> = {
  pose: { count: 98, subs: [['cute', 25], ['sitting', 14], ['standing', 14], ['kneeling', 10], ['lying-down', 9], ['side-sitting', 8], ['squatting', 6], ['leaning-forward', 6], ['leaning-back', 3], ['twisting', 3]] },
  pose_depth: { count: 98, subs: [['cute', 25], ['sitting', 14], ['standing', 14], ['kneeling', 10], ['lying-down', 9], ['side-sitting', 8], ['squatting', 6], ['leaning-forward', 6], ['leaning-back', 3], ['twisting', 3]] },
  portrait: { count: 1499, subs: [['front', 893], ['lifestyle', 606]] },
  expression: {
    count: 95,
    subs: [['happy', 8], ['laughing', 7], ['angry', 8], ['sad', 8], ['surprised', 7], ['scared', 7], ['confused', 7], ['disgusted', 6], ['flirty', 7], ['serious', 7], ['shy', 5], ['silly', 6], ['smug', 6], ['tired', 6]],
  },
  hairstyle: { count: 0, subs: [] },
  outfit: { count: 1067, subs: [['spring', 215], ['summer', 254], ['autumn', 243], ['winter', 253], ['party', 48], ['swimsuit', 54]] },
  outfit_anime: { count: 983, subs: [['spring', 197], ['summer', 237], ['autumn', 229], ['winter', 232], ['party', 36], ['swimsuit', 52]] },
  outfit_historical: {
    count: 57,
    subs: [['shang', 2], ['han', 4], ['wei-jin', 4], ['tang', 6], ['song', 8], ['yuan', 2], ['ming', 14], ['qing', 6], ['republican', 8], ['wedding', 3]],
  },
  scene: { count: 64, subs: [['indoor', 14], ['city', 12], ['nature', 17], ['historical-and-fantasy', 15], ['studio', 6]] },
  lighting: { count: 50, subs: [['time-of-day', 11], ['spaces', 11], ['artistic', 11], ['portrait-lighting', 10], ['effects', 7]] },
  prop: { count: 32, subs: [['handheld-everyday', 12], ['instruments', 10], ['traditional-objects', 10]] },
  furniture: { count: 41, subs: [['seating', 16], ['tables', 5], ['chinese-style', 11], ['studio-structures', 9]] },
};

/** Glyphs from PublicLibrary.dc.html, drawn on cards until thumbnails are served. */
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
  count: number;
  subs: Array<[string, number]>;
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
  return { key: def.key, def, glyph: v.glyph, ar: v.ar, cta: `library.public.cta.${v.cta}`, count: CATALOG[def.key].count, subs: CATALOG[def.key].subs };
}

/** Groups and categories in registry order, without empty categories. */
export const CATEGORY_GROUPS = LIBRARY_GROUPS.map((g) => ({
  group: g,
  categories: LIBRARY_CATEGORIES.filter((c) => c.group === g.key && CATALOG[c.key].count > 0).map(categoryView),
})).filter((g) => g.categories.length > 0);

export const VISIBLE_CATEGORIES = CATEGORY_GROUPS.flatMap((g) => g.categories);

export function findCategory(key: string | undefined): CategoryView {
  return VISIBLE_CATEGORIES.find((c) => c.key === key) ?? VISIBLE_CATEGORIES[0]!;
}

/** License chip colors from PublicLibrary.dc.html. First-party items carry no label (D-004). */
export const LICENSE_CHIP: Record<'cc0' | 'mit', { bg: string; fg: string }> = {
  cc0: { bg: 'rgba(34,197,94,.12)', fg: '#4ADE80' },
  mit: { bg: 'rgba(59,130,246,.14)', fg: '#93C5FD' },
};

/** Short card id, e.g. `pw_pose_full_single_P001` → `P001`. */
export function shortId(id: string): string {
  const tail = id.split('_').pop() ?? id;
  return tail.length > 8 ? tail.slice(0, 6).toUpperCase() : tail;
}
