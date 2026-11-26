import type { FeedItem } from '../types';

/** Mock data for Characters, matching Character.dc.html. */
/** The design's sample character: measurements and chip choices. */
export const characterSample = { age: '28', height: '168', pick: { hair: 'sideBob', body: 'balanced', wear: 'cityCasual', style: 'photoreal' } };

/** The design's Advanced "Model" short list (catalog ids). */
export const characterSegIds = ['bytedance/seedream-5.5', 'qwen/qwen-image-2.0'];
export const characterSettings = { resolution: '2K' };

/** Mock-mode estimate shown where real mode shows the server's quote. */
export function characterMockCost(o: { adv: boolean; res: string }): number {
  const res: Record<string, number> = { '1K': 2, '2K': 4, '4K': 8 };
  return o.adv ? (res[o.res] ?? 4) : 4;
}

export const characterPrompt = 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling.';

const ACTS = ['redo', 'sliders', 'save', 'down', 'star'] as const;
const pair = (a: string, b: string) => [
  { label: 'Full body', tone: a },
  { label: 'Face', tone: b },
];

export const characterFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_c1', aspect: '2/3', tiles: pair('var(--c-tone-blank)', 'var(--c-tone-blank)'), video: false, progress: 71,
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
    kind: 'media', id: 'run_c2', aspect: '2/3', tiles: pair('var(--c-tone-moss)', 'var(--c-tone-sage)'), video: false,
    prompt: 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling',
    tags: ['28 y/o', '168 cm', 'Side-part bob', 'City casual', 'Photoreal'], finishedAgoMin: 15, actions: [...ACTS],
  },
  {
    kind: 'media', id: 'run_c3', aspect: '2/3', tiles: pair('var(--c-tone-plum)', 'var(--c-tone-mauve)'), video: false,
    prompt: 'Youthful, short hair, bright expression', tags: ['19 y/o', 'Short crop', 'Athleisure', 'Anime'], finishedAgoMin: 24 * 60, actions: [...ACTS],
  },
];
