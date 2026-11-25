import { LIBRARY_CATEGORIES } from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import type { PromptIconName } from './icons';
import type { PromptCommand, RefGlyph, RefItem } from './types';

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
  { id: 'ast_m1', group: 'mine', name: 'Product photo', meta: 'Image · 2048×2048', source: 'mine', tone: '#26232A', glyph: icon('img') },
  { id: 'ast_m2', group: 'mine', name: 'Shot A v2', meta: 'Video · 0:05', source: 'mine', tone: '#1F2628', glyph: icon('vid') },
  { id: 'ast_m3', group: 'mine', name: 'Pack front', meta: 'Image · 3024×4032', source: 'team', tone: '#28251F', glyph: icon('img') },
  { id: 'ast_m4', group: 'mine', name: 'Tagline', meta: 'Text · 24 chars', source: 'mine', tone: '#26262A', glyph: icon('txt') },
  { id: 'chr_c1', group: 'char', name: 'Mia', meta: 'Character · Photoreal', source: 'mine', tone: '#202330', glyph: letter('M') },
  { id: 'chr_c2', group: 'char', name: 'Leo', meta: 'Character · Photoreal', source: 'mine', tone: '#1F2622', glyph: letter('L') },
  { id: 'chr_c3', group: 'char', name: 'Yuki', meta: 'Character · Anime', source: 'team', tone: '#2A2420', glyph: letter('Y') },
  { id: 'chr_c4', group: 'char', name: 'Product advisor', meta: 'Avatar · Built-in', source: 'builtin', tone: '#22262E', glyph: letter('P') },
  { id: 'voc_v1', group: 'voice', name: 'Clear female', meta: 'Voice · English', source: 'builtin', tone: '#1C1C1F', glyph: wave },
  { id: 'voc_v2', group: 'voice', name: 'My voice 01', meta: 'Voice · Cloned', source: 'mine', tone: '#1C1C1F', glyph: wave },
  { id: 'voc_v3', group: 'voice', name: 'Steady male', meta: 'Voice · English', source: 'builtin', tone: '#1C1C1F', glyph: wave },
  pub('pw_pose_P001', 'pose', 'Sitting sideways', 'Pose P001 · 5 angles', icon('pose'), '#26232A'),
  pub('pw_pose_P014', 'pose', 'Hands on hips', 'Pose P014 · 5 angles', icon('pose'), '#202330'),
  pub('pw_outfit_W001', 'outfit', 'Beige trench', 'Outfit W001', icon('wear'), '#28251F'),
  pub('pw_outfit_W009', 'outfit', 'Linen shirt', 'Outfit W009', icon('wear'), '#1F2628'),
  pub('pw_portrait_R001', 'portrait', 'Short hair, front', 'Portrait R001 · CC0', icon('user'), '#22262E'),
  pub('pw_expression_E001', 'expression', 'Gentle smile', 'Expression E001 · MIT', icon('face'), '#26262A'),
  pub('pw_hairstyle_S001', 'hairstyle', 'Flipped bob', 'Hairstyle S001 · CC0', icon('hair'), '#2A2420'),
  pub('pw_scene_B001', 'scene', 'Café window', 'Scene B001 · CC0', icon('scene'), '#1F2622'),
  pub('pw_lighting_L001', 'lighting', 'Rembrandt', 'Lighting L001 · CC0', icon('light'), '#26232A'),
  pub('pw_prop_O001', 'prop', 'Coffee cup', 'Prop O001 · CC0', icon('prop'), '#1F2628'),
];

/** Built-in skills (Main.dc.html `SK`). Users can add their own in Settings. */
export const MOCK_SKILLS: PromptCommand[] = [
  { id: 'skl_tv_ad', name: 'TV ad', icon: 'film', kind: 'skill', description: '15–30s ads with script, storyboard and logo end card' },
  { id: 'skl_comic', name: 'AI comic', icon: 'book', kind: 'skill', description: 'Turns a story or outline into episodes, characters and storyboards' },
  { id: 'skl_product', name: 'Product showcase', icon: 'bag', kind: 'skill', description: 'Turns a product photo into multi-angle shots' },
  { id: 'skl_remake', name: 'Shot-for-shot remake', icon: 'copy', kind: 'skill', description: 'Upload a reference video and recreate its shots' },
  { id: 'skl_brand', name: 'Brand kit', icon: 'brand', kind: 'skill', description: 'Brand colors, fonts, intros and outros' },
];
