import type { PromptCommand } from './types';

/** Built-in skills (Main.dc.html `SK`). Users can add their own in Settings. */
export const BUILTIN_SKILLS: PromptCommand[] = [
  { id: 'skl_tv_ad', name: 'TV ad', icon: 'film', kind: 'skill', description: '15–30s ads with script, storyboard and logo end card' },
  { id: 'skl_comic', name: 'AI comic', icon: 'book', kind: 'skill', description: 'Turns a story or outline into episodes, characters and storyboards' },
  { id: 'skl_product', name: 'Product showcase', icon: 'bag', kind: 'skill', description: 'Turns a product photo into multi-angle shots' },
  { id: 'skl_remake', name: 'Shot-for-shot remake', icon: 'copy', kind: 'skill', description: 'Upload a reference video and recreate its shots' },
  { id: 'skl_brand', name: 'Brand kit', icon: 'brand', kind: 'skill', description: 'Brand colors, fonts, intros and outros' },
];
