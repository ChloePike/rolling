import type { FeedItem } from '../types';

/** Mock data for Avatar, matching DigitalHuman.dc.html. */
export const avatarLooks = [
  { id: 'character', value: 'Product advisor', tone: 'var(--c-tone-teal)' },
  { id: 'scene', value: 'Office · Uploaded', tone: 'var(--c-tone-indigo)' },
] as const;

/** Choices behind the look rows. */
export const avatarLookOptions: Record<(typeof avatarLooks)[number]['id'], string[]> = {
  character: ['Product advisor', 'Friendly host', 'Lab coat expert', 'Casual creator'],
  scene: ['Office · Uploaded', 'Bright studio', 'Home kitchen', 'Bookshelf'],
};

export const avatarPersonas: Array<[string, string]> = [
  ['Expert presenter', 'First, how it’s divided. Then, how to use it.'],
  ['Friendly lifestyle creator', 'This is where all my everyday stuff goes.'],
  ['Energetic product host', 'See these compartments? Everything’s easy to grab.'],
  ['Patient teacher', 'Step one: group similar things together.'],
  ['Calm news anchor', 'This organizer is built around compartments.'],
  ['Gentle companion', 'Start with one small corner. That’s enough.'],
  ['Comedian', 'However messy the desk, small things need a home.'],
  ['Storyteller', 'I used to hunt for my keys every time I left the house.'],
  ['Steady business advisor', 'The point is less time looking for things.'],
  ['Outdoor reviewer', 'Let me show you what I keep in here.'],
];

export const avatarVoices: Array<[string, string]> = [
  ['Clear female', 'American English · Medium pace'],
  ['Steady male', 'Deep · Good for explainers'],
  ['Warm female', 'Relaxed · Everyday'],
  ['Upbeat male', 'Bright · Good for selling'],
];

/** The design's Advanced "Lip-sync method" short list (catalog ids) and composer pills (9:16, 10s, 720p). */
export const avatarSegIds = ['minimax/minimax-h3', 'lumina/wan2.7-i2v-spicy'];
export const avatarSettings = { ratio: '9:16', resolution: '720p' };
export const avatarSeconds = 10;

/** Mock-mode estimate shown where real mode shows the server's quote. */
export function avatarMockCost(o: { adv: boolean; res: string }): number {
  const res: Record<string, number> = { '480p': 6, '720p': 10, '1080p': 18 };
  return (o.adv ? (res[o.res] ?? 10) : 10) + 2;
}

export const avatarClone = { name: 'My voice 01', progress: 64 };

export const avatarPrompt =
  'Cover two things about the desk organizer: separate compartments and easy reach. Open with: “Messy desk? Give everything a spot.”';

const ACTS = ['redo', 'sliders', 'frame', 'down', 'star'] as const;

export const avatarFeed: FeedItem[] = [
  {
    kind: 'draft', id: 'draft_a1', title: 'Script draft', meta: 'Expert presenter · Clear female · About 9s of 10s',
    lines: [
      { at: '00:00', text: 'Messy desk? Give everything a spot.', exact: true, action: 'Looks at camera' },
      { at: '00:03', text: 'This organizer keeps small things apart,', exact: false, action: 'Points at the organizer' },
      { at: '00:06', text: 'You can see everything at a glance.', exact: false, action: 'Smiles and nods' },
    ],
  },
  {
    kind: 'media', id: 'run_a1', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-blank)' }], video: true, progress: 48,
    prompt: 'Explain the compartments, end with a smile and a nod', tags: ['9:16', '10s', 'Clear female'],
    steps: [
      { label: 'Script', state: 'done' },
      { label: 'Text to speech', state: 'done' },
      { label: 'Lip-sync 48%', state: 'now' },
    ],
    actions: [...ACTS],
  },
  { kind: 'media', id: 'run_a2', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-teal)' }], video: true, durationSec: 10, prompt: 'Desk organizer pitch · Expert presenter', tags: ['9:16', '10s', '720p'], finishedAgoMin: 24 * 60, actions: [...ACTS] },
  { kind: 'media', id: 'run_a3', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-sand)' }], video: true, durationSec: 15, prompt: 'New coffee maker highlights · Energetic host', tags: ['9:16', '15s', '720p'], finishedAgoMin: 3 * 24 * 60, actions: [...ACTS] },
];
