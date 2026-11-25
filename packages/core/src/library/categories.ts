import type {
  LibraryAttribution,
  LibraryCategoryKey,
  LibraryGroupKey,
  LibraryLicense,
} from './types';

/**
 * Category registry for the public library (D-004).
 *
 * Labels are English source strings; the UI renders them through
 * `messages/<locale>.json` using `messageId`.
 */

/** PoseWear's own tab key for each category (its data files and deep links use these). */
export type PoseWearTab =
  | 'pose'
  | 'depth'
  | 'costume'
  | 'anime'
  | 'portrait'
  | 'expr'
  | 'hair'
  | 'dyn'
  | 'scene'
  | 'light'
  | 'prop'
  | 'furn';

export interface LibraryGroup {
  key: LibraryGroupKey;
  label: string;
  messageId: string;
}

export interface LibraryCategory {
  key: LibraryCategoryKey;
  group: LibraryGroupKey;
  label: string;
  messageId: string;
  license: LibraryLicense;
  /** Short English license note shown in the details panel. */
  licenseNote: string;
  /** Item count shown in the PoseWear menu at import time (D-004 table). */
  expectedCount: number;
  /** PoseWear tab key, also the prefix of its deep links (`/#<tab>/<id>`). */
  sourceTab: PoseWearTab;
  /** File stem of the PoseWear data index: `/assets/<stem>.<hash>.json`. */
  sourceFileStem: string;
  attribution: LibraryAttribution;
  /** True when items have several camera angles or variants. */
  multiAngle: boolean;
}

export const LIBRARY_GROUPS: readonly LibraryGroup[] = [
  { key: 'pose', label: 'Pose', messageId: 'library.group.pose' },
  { key: 'character', label: 'Character look', messageId: 'library.group.character' },
  { key: 'wardrobe', label: 'Wardrobe', messageId: 'library.group.wardrobe' },
  { key: 'scene', label: 'Scene & props', messageId: 'library.group.scene' },
];

const FIRST_PARTY_NOTE = 'PoseWear original content.';
const SHISEI: LibraryAttribution = { name: 'Shisei', author: 'wquguru' };

export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = [
  {
    key: 'pose',
    group: 'pose',
    label: 'Poses',
    messageId: 'library.category.pose',
    license: 'first-party',
    licenseNote: FIRST_PARTY_NOTE,
    expectedCount: 288,
    sourceTab: 'pose',
    sourceFileStem: 'poses',
    attribution: { name: 'AI Pose Gallery', url: 'https://ai-pose-gallery.pages.dev/', author: '@giaaibusi' },
    multiAngle: true,
  },
  {
    key: 'pose_depth',
    group: 'pose',
    label: 'Depth poses',
    messageId: 'library.category.pose_depth',
    license: 'first-party',
    licenseNote: FIRST_PARTY_NOTE,
    expectedCount: 288,
    sourceTab: 'depth',
    sourceFileStem: 'depths',
    attribution: {
      name: 'AI Pose Depth Gallery',
      url: 'https://ai-pose-depth-gallery.pages.dev/',
      author: '@giaaibusi',
    },
    multiAngle: true,
  },
  {
    key: 'portrait',
    group: 'character',
    label: 'Portraits',
    messageId: 'library.category.portrait',
    license: 'cc0',
    licenseNote: 'CC0 1.0. All people are fictional. Please do not repost in bulk.',
    expectedCount: 1499,
    sourceTab: 'portrait',
    sourceFileStem: 'portraits',
    attribution: {
      name: 'AI Portrait Gallery',
      url: 'https://ai-portrait-gallery.pages.dev/',
      author: '@agi_aibusi',
    },
    multiAngle: false,
  },
  {
    key: 'expression',
    group: 'character',
    label: 'Expressions',
    messageId: 'library.category.expression',
    license: 'mit',
    licenseNote: 'MIT. Head model from ICT-FaceKit, (c) USC Institute for Creative Technologies.',
    expectedCount: 95,
    sourceTab: 'expr',
    sourceFileStem: 'expressions',
    attribution: { name: 'WaveSpeed AI Emotion Gallery, ICT-FaceKit head model' },
    multiAngle: true,
  },
  {
    key: 'hairstyle',
    group: 'character',
    label: 'Hairstyles',
    messageId: 'library.category.hairstyle',
    license: 'cc0',
    licenseNote: 'Marked CC0 by CharaDB.',
    expectedCount: 122,
    sourceTab: 'hair',
    sourceFileStem: 'hair',
    attribution: { name: 'CharaDB', url: 'https://charadb-2fi.pages.dev/' },
    multiAngle: true,
  },
  {
    key: 'outfit',
    group: 'wardrobe',
    label: 'Outfits',
    messageId: 'library.category.outfit',
    license: 'first-party',
    licenseNote: FIRST_PARTY_NOTE,
    expectedCount: 1407,
    sourceTab: 'costume',
    sourceFileStem: 'costumes',
    attribution: {
      name: 'AI Costume Gallery',
      url: 'https://ai-costume-gallery.pages.dev/',
      author: '@giaaibusi',
    },
    multiAngle: false,
  },
  {
    key: 'outfit_anime',
    group: 'wardrobe',
    label: 'Anime outfits',
    messageId: 'library.category.outfit_anime',
    license: 'first-party',
    licenseNote: FIRST_PARTY_NOTE,
    expectedCount: 1760,
    sourceTab: 'anime',
    sourceFileStem: 'anime',
    attribution: {
      name: 'AI Costume Anime Gallery',
      url: 'https://ai-costume-anime-gallery.pages.dev/',
      author: '@giaaibusi',
    },
    multiAngle: false,
  },
  {
    key: 'outfit_historical',
    group: 'wardrobe',
    label: 'Historical',
    messageId: 'library.category.outfit_historical',
    license: 'cc0',
    licenseNote: 'CC0 1.0, commercial use OK.',
    expectedCount: 57,
    sourceTab: 'dyn',
    sourceFileStem: 'dynasties',
    attribution: SHISEI,
    multiAngle: true,
  },
  {
    key: 'scene',
    group: 'scene',
    label: 'Scenes',
    messageId: 'library.category.scene',
    license: 'cc0',
    licenseNote: 'CC0 1.0, commercial use OK.',
    expectedCount: 64,
    sourceTab: 'scene',
    sourceFileStem: 'scenes',
    attribution: SHISEI,
    multiAngle: true,
  },
  {
    key: 'lighting',
    group: 'scene',
    label: 'Lighting',
    messageId: 'library.category.lighting',
    license: 'cc0',
    licenseNote: 'CC0 1.0, commercial use OK.',
    expectedCount: 50,
    sourceTab: 'light',
    sourceFileStem: 'lights',
    attribution: SHISEI,
    multiAngle: true,
  },
  {
    key: 'prop',
    group: 'scene',
    label: 'Props',
    messageId: 'library.category.prop',
    license: 'cc0',
    licenseNote: 'CC0 1.0, commercial use OK.',
    expectedCount: 32,
    sourceTab: 'prop',
    sourceFileStem: 'props',
    attribution: SHISEI,
    multiAngle: true,
  },
  {
    key: 'furniture',
    group: 'scene',
    label: 'Furniture',
    messageId: 'library.category.furniture',
    license: 'cc0',
    licenseNote: 'CC0 1.0, commercial use OK.',
    expectedCount: 41,
    sourceTab: 'furn',
    sourceFileStem: 'furniture',
    attribution: SHISEI,
    multiAngle: true,
  },
];

const BY_KEY = new Map(LIBRARY_CATEGORIES.map((c) => [c.key, c]));
const BY_TAB = new Map(LIBRARY_CATEGORIES.map((c) => [c.sourceTab, c]));

export function getLibraryCategory(key: LibraryCategoryKey): LibraryCategory {
  const category = BY_KEY.get(key);
  if (!category) throw new Error(`Unknown library category: ${key}`);
  return category;
}

export function categoryForPoseWearTab(tab: string): LibraryCategory | undefined {
  return BY_TAB.get(tab as PoseWearTab);
}

export function categoriesInGroup(group: LibraryGroupKey): LibraryCategory[] {
  return LIBRARY_CATEGORIES.filter((c) => c.group === group);
}
