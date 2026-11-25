import type { FeedItem } from '../types';

/** Mock data for Remix, matching OriginalVideo.dc.html. */
export const remixPresets = [
  { id: 'action', icon: 'body', value: 'Table demo', tone: '#1F2628' },
  { id: 'outfit', icon: 'shirt', value: 'Smart casual', tone: '#28251F' },
  { id: 'scene', icon: 'scene', value: 'Daylight studio', tone: '#202330' },
] as const;

export const remixSlotTones = ['#26232A', '#1F2628', '#202330', '#28251F', '#26262A'];

export const remixParsed = {
  camera: 'Slow push-in, ending on a two-shot',
  line1: '“Let’s get started.”',
  action1: 'Holds up the product, showing the front of the pack',
  action2: 'Nods after character 1 lifts the product',
};

export const remixPrompt =
  'Slow push-in. Character 1 lifts the product and says “Let’s get started.” Character 2 nods back. End on a two-shot.';

const ACTS = ['redo', 'sliders', 'frame', 'down', 'star'] as const;

export const remixFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_r1', aspect: '16/9', tiles: [{ tone: '#1C1C1F' }], video: true, progress: 34,
    prompt: 'Slow push-in. Character 1 lifts the product and says “Let’s get started.” Character 2 nods. End on a two-shot',
    tags: ['16:9', '10s', '720p', '2 people'],
    steps: [
      { label: 'Tidy description', state: 'done' },
      { label: 'Seedance 2.5', state: 'done' },
      { label: 'Generating 34%', state: 'now' },
      { label: 'Saved', state: 'todo' },
    ],
    actions: [...ACTS],
  },
  { kind: 'media', id: 'run_r2', aspect: '16/9', tiles: [{ tone: '#202330' }], video: true, durationSec: 10, prompt: 'Two people show the product at a table, camera trucks left to right', tags: ['16:9', '10s', '720p', '2 people'], finishedAgoMin: 20, actions: [...ACTS] },
  { kind: 'media', id: 'run_r3', aspect: '16/9', tiles: [{ tone: '#28251F' }], video: true, durationSec: 5, prompt: 'One person holds up the product, locked-off camera', tags: ['16:9', '5s', '480p', '1 P'], finishedAgoMin: 24 * 60, actions: [...ACTS] },
];
