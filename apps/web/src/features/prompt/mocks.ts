import { LIBRARY_CATEGORIES } from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import type { PromptIconName } from './icons';
import type { RefGlyph, RefItem } from './types';

/**
 * Mock data shaped like `GET /api/assets?scope=all` and the skills list.
 * Values match Main.dc.html so the screens can be compared pixel for pixel.
 * The public items here are the user's recent picks (All tab); the Public
 * library tab itself reads the GraphQL API.
 */

const letter = (l: string) => ({ type: 'letter', letter: l }) as const;
const icon = (i: PromptIconName): RefGlyph => ({ type: 'icon', icon: i });
const wave = { type: 'wave' } as const;

function pub(
  id: string,
  category: LibraryCategoryKey,
  name: string,
  meta: string,
  glyph: RefGlyph,
  tone: string,
): RefItem {
  const cat = LIBRARY_CATEGORIES.find((c) => c.key === category)!;
  return {
    id,
    group: 'pub',
    category,
    name,
    meta,
    source: 'public',
    tone,
    glyph,
    license: cat.license,
  };
}

export const MOCK_REFERENCES: RefItem[] = [
  { id: 'ast_m1', group: 'mine', name: 'Product photo', meta: 'Image · 2048×2048', source: 'mine', tone: 'var(--c-tone-plum)', glyph: icon('img') },
  { id: 'ast_m2', group: 'mine', name: 'Shot A v2', meta: 'Video · 0:05', source: 'mine', tone: 'var(--c-tone-teal)', glyph: icon('vid') },
  { id: 'ast_m3', group: 'mine', name: 'Pack front', meta: 'Image · 3024×4032', source: 'team', tone: 'var(--c-tone-sand)', glyph: icon('img') },
  { id: 'ast_m4', group: 'mine', name: 'Tagline', meta: 'Text · 24 chars', source: 'mine', tone: 'var(--c-tone-neutral)', glyph: icon('txt') },
  { id: 'chr_c1', group: 'char', name: 'Mia', meta: 'Character · Photoreal', source: 'mine', tone: 'var(--c-tone-indigo)', glyph: letter('M') },
  { id: 'chr_c2', group: 'char', name: 'Leo', meta: 'Character · Photoreal', source: 'mine', tone: 'var(--c-tone-moss)', glyph: letter('L') },
  { id: 'chr_c3', group: 'char', name: 'Yuki', meta: 'Character · Anime', source: 'team', tone: 'var(--c-tone-clay)', glyph: letter('Y') },
  { id: 'chr_c4', group: 'char', name: 'Product advisor', meta: 'Avatar · Built-in', source: 'builtin', tone: 'var(--c-tone-slate)', glyph: letter('P') },
  { id: 'voc_v1', group: 'voice', name: 'Clear female', meta: 'Voice · English', source: 'builtin', tone: 'var(--c-tone-blank)', glyph: wave },
  { id: 'voc_v2', group: 'voice', name: 'My voice 01', meta: 'Voice · Cloned', source: 'mine', tone: 'var(--c-tone-blank)', glyph: wave },
  { id: 'voc_v3', group: 'voice', name: 'Steady male', meta: 'Voice · English', source: 'builtin', tone: 'var(--c-tone-blank)', glyph: wave },
  pub('pw_pose_P001', 'pose', 'Sitting sideways', 'Pose P001 · 5 angles', icon('pose'), 'var(--c-tone-plum)'),
  pub('pw_pose_P014', 'pose', 'Hands on hips', 'Pose P014 · 5 angles', icon('pose'), 'var(--c-tone-indigo)'),
  pub('pw_outfit_W001', 'outfit', 'Beige trench', 'Outfit W001', icon('wear'), 'var(--c-tone-sand)'),
  pub('pw_outfit_W009', 'outfit', 'Linen shirt', 'Outfit W009', icon('wear'), 'var(--c-tone-teal)'),
  pub('pw_portrait_R001', 'portrait', 'Short hair, front', 'Portrait R001 · CC0', icon('user'), 'var(--c-tone-slate)'),
  pub('pw_expression_E001', 'expression', 'Gentle smile', 'Expression E001 · MIT', icon('face'), 'var(--c-tone-neutral)'),
  pub('pw_hairstyle_S001', 'hairstyle', 'Flipped bob', 'Hairstyle S001 · CC0', icon('hair'), 'var(--c-tone-clay)'),
  pub('pw_scene_B001', 'scene', 'Café window', 'Scene B001 · CC0', icon('scene'), 'var(--c-tone-moss)'),
  pub('pw_lighting_L001', 'lighting', 'Rembrandt', 'Lighting L001 · CC0', icon('light'), 'var(--c-tone-plum)'),
  pub('pw_prop_O001', 'prop', 'Coffee cup', 'Prop O001 · CC0', icon('prop'), 'var(--c-tone-teal)'),
];
