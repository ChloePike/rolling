import type { FeedItem } from '../types';

/** Mock data for Quick Create, matching QuickCreate.dc.html. */
export const quickTemplate = { name: 'Two-person product demo', aspect: '9:16', durationSec: 15, shots: 3, style: 'Dialogue', tone: '#202330' };

export const quickSlots = [
  { name: 'Lead', uploaded: true, shots: '1, 2, 3', tone: '#26232A' },
  { name: 'Partner', uploaded: false, tone: '#26262A' },
];

export const quickLines = [
  { id: 'l1', who: 'Lead', from: 2, to: 5, text: 'Here is what I use every morning.' },
  { id: 'l2', who: 'Partner', from: 9, to: 12, text: 'Just one step, and I am ready to go.' },
];

export const quickShots = [
  { id: 'S01', from: 0, to: 5, desc: 'Locked medium shot · Lead walks to the table and picks up the cup', fields: [['action', 'open'], ['camera', 'open'], ['lightingLocked', 'lock']] },
  { id: 'S02', from: 5, to: 10, desc: 'Close · Lead raises the cup to chest height', fields: [['lightingChanged', 'edit'], ['camera', 'open'], ['focusLocked', 'lock']] },
  { id: 'S03', from: 10, to: 15, desc: 'Close-up · Cup back on the wooden table', fields: [['focus', 'open'], ['action', 'open']] },
] as const;

export const quickPrompt = 'In shot 2, change the daylight outside the window to warm golden-hour light';

const ACTS = ['redo', 'sliders', 'frame', 'down', 'star'] as const;

export const quickFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_q1', aspect: '9/16', tiles: [{ tone: '#1C1C1F' }], video: true, progress: 62,
    prompt: 'Shot 2: golden-hour light outside the window. Everything else stays.', tags: ['9:16', '15s', '720p', '1 change'],
    steps: [
      { label: 'Find shot 2', state: 'done' },
      { label: 'Seedance 2.5', state: 'done' },
      { label: 'Generating 62%', state: 'now' },
      { label: 'Generate speech', state: 'todo' },
    ],
    actions: [...ACTS],
  },
  { kind: 'media', id: 'run_q2', aspect: '9/16', tiles: [{ tone: '#26232A' }], video: true, durationSec: 15, prompt: 'Swap the lead, switch lines to English', tags: ['9:16', '15s', '720p'], finishedAgoMin: 10, actions: [...ACTS] },
  { kind: 'media', id: 'run_q3', aspect: '9/16', tiles: [{ tone: '#202330' }], video: true, durationSec: 10, prompt: 'Cut to 10s, keep both lines', tags: ['9:16', '10s', '720p'], finishedAgoMin: 60, actions: [...ACTS] },
  { kind: 'media', id: 'run_q4', aspect: '9/16', tiles: [{ tone: '#1F2628' }], video: true, durationSec: 15, prompt: 'Same settings as the original', tags: ['9:16', '15s', '480p'], finishedAgoMin: 24 * 60, actions: [...ACTS] },
];
