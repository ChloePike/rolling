import type { TemplateSummary } from './types';

/** Mock catalog matching Templates.dc.html and the Inspiration feed on Main.dc.html. */
const NAMES = [
  'Two-person product demo',
  'Portrait by a window',
  'Unboxing close-ups',
  'Street style',
  'Breakfast vlog',
  'Holiday gift',
  'Coffee maker features',
  'Skincare close-ups',
  'Period drama opener',
  'Sneaker try-on',
  'Restaurant visits',
  'Office picks',
];
const DUR = [15, 15, 10, 8, 15, 15, 12, 10, 30, 8, 20, 12];
const ROLES = [2, 1, 1, 1, 1, 2, 1, 1, 3, 1, 2, 1];
const LINES = [true, false, true, false, true, true, true, false, true, false, true, true];
const ASPECT = ['3/4', '9/16', '1/1', '3/4', '4/5', '9/16', '16/10', '3/4', '1/1', '9/16', '9/16', '9/16'];
const CATEGORY: TemplateSummary['category'][] = [
  'product', 'talking', 'product', 'outfit', 'talking', 'holiday', 'product', 'product', 'drama', 'outfit', 'venue', 'explainer',
];

export const MOCK_TEMPLATES: TemplateSummary[] = NAMES.map((name, i) => ({
  id: `tpl_${String(i + 1).padStart(2, '0')}`,
  name,
  durationSec: DUR[i]!,
  uses: ((i * 937) % 9000) + 600,
  roles: ROLES[i]!,
  hasLines: LINES[i]!,
  coverAspect: ASPECT[i]!,
  category: CATEGORY[i]!,
}));

export const MOCK_FEATURED: TemplateSummary[] = [
  {
    ...MOCK_TEMPLATES[0]!,
    id: 'tpl_f1',
    featured: true,
    uses: 12000,
    description: 'Two characters trade lines to present a product. 3 shots, camera moves and pacing included.',
    tags: ['2 characters', 'Dialogue', 'Any language'],
  },
  {
    ...MOCK_TEMPLATES[8]!,
    id: 'tpl_f2',
    featured: true,
    uses: 8640,
    description: 'A period-costume character entrance for drama and comic openers. Swap the setting freely.',
    tags: ['3 characters', 'Dialogue', 'New setting'],
  },
];

/** Total in the catalog (the mock shows the first page). */
export const MOCK_TEMPLATE_TOTAL = 128;
