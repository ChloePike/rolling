import type { FeedItem } from '../types';

/** Mock data for Characters, matching Character.dc.html. */
export const characterStyleTones = ['#1F2622', '#26232A', '#202330', '#28251F', '#26262A', '#1F2628', '#2A2420'];
export const characterStyles = ['photoreal', 'anime', '3d', 'painterly', 'ink', 'comic', 'clay'];
export const characterHair = ['fromDescription', 'shortCrop', 'sideBob', 'long', 'curls', 'ponytail', 'updo'];
export const characterBody = ['balanced', 'slim', 'athletic', 'broad', 'curvy', 'stocky'];
export const characterOutfits = ['cityCasual', 'business', 'athleisure', 'streetwear', 'hanfu', 'outdoor'];

export const characterPrompt = 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling.';

const ACTS = ['redo', 'sliders', 'save', 'down', 'star'] as const;
const pair = (a: string, b: string) => [
  { label: 'Full body', tone: a },
  { label: 'Face', tone: b },
];

export const characterFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_c1', aspect: '2/3', tiles: pair('#1C1C1F', '#1C1C1F'), video: false, progress: 71,
    prompt: characterPrompt, tags: ['28 y/o', '168 cm', 'Side-part bob', 'Balanced', 'City casual', 'Photoreal'],
    steps: [
      { label: 'Build description', state: 'done' },
      { label: 'Seedream 5.0 Pro', state: 'done' },
      { label: 'Generating 71%', state: 'now' },
      { label: 'Consistency check', state: 'todo' },
    ],
    actions: [...ACTS],
  },
  {
    kind: 'media', id: 'run_c2', aspect: '2/3', tiles: pair('#1F2622', '#22292A'), video: false,
    prompt: 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling',
    tags: ['28 y/o', '168 cm', 'Side-part bob', 'City casual', 'Photoreal'], finishedAgoMin: 15, actions: [...ACTS],
  },
  {
    kind: 'media', id: 'run_c3', aspect: '2/3', tiles: pair('#26232A', '#2A2630'), video: false,
    prompt: 'Youthful, short hair, bright expression', tags: ['19 y/o', 'Short crop', 'Athleisure', 'Anime'], finishedAgoMin: 24 * 60, actions: [...ACTS],
  },
];
