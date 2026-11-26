import type { FeedItem } from '../types';

/** Mock data for Quick Create, matching QuickCreate.dc.html. */
export const quickTemplate = { name: 'Two-person product demo', aspect: '9:16', durationSec: 15, shots: 3, style: 'Dialogue', tone: 'var(--c-tone-indigo)' };

export const quickSlots = [
  { name: 'Lead', uploaded: true, shots: '1, 2, 3', tone: 'var(--c-tone-plum)' },
  { name: 'Partner', uploaded: false, tone: 'var(--c-tone-neutral)' },
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

/** The design's composer pills: 9:16 (the template's), 15s, 720p. */
export const quickSettings = { ratio: '9:16', seconds: 15, resolution: '720p' };

/** The design's Advanced seed and "Model" short list (catalog ids). */
export const quickSeed = '48213';
export const quickSegIds = ['bytedance/seedance-2.5', 'bytedance/seedance-2.0-mini', 'minimax/minimax-h3'];

/** The design's note chip ("Only changes Shot 2 · Lighting"): message ids for Simple and Advanced. */
export const quickNoteChips = { simple: 'tools.quick.note.chip', advanced: 'tools.quick.note.chipAdv' };

/** Mock-mode estimate shown where real mode shows the server's quote. */
export function quickMockCost(o: { adv: boolean; res: string; count: number }): number {
  const res: Record<string, number> = { '480p': 6, '720p': 10, '1080p': 18 };
  return o.adv ? (res[o.res] ?? 10) * o.count : 10;
}

export const quickPrompt = 'In shot 2, change the daylight outside the window to warm golden-hour light';

const ACTS = ['redo', 'sliders', 'frame', 'down', 'star'] as const;

export const quickFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_q1', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-blank)' }], video: true, progress: 62,
    prompt: 'Shot 2: golden-hour light outside the window. Everything else stays.', tags: ['9:16', '15s', '720p', '1 change'],
    steps: [
      { label: 'Find shot 2', state: 'done' },
      { label: 'Seedance 2.5', state: 'done' },
      { label: 'Generating 62%', state: 'now' },
      { label: 'Generate speech', state: 'todo' },
    ],
    actions: [...ACTS],
  },
  { kind: 'media', id: 'run_q2', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-plum)' }], video: true, durationSec: 15, prompt: 'Swap the lead, switch lines to English', tags: ['9:16', '15s', '720p'], finishedAgoMin: 10, actions: [...ACTS] },
  { kind: 'media', id: 'run_q3', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-indigo)' }], video: true, durationSec: 10, prompt: 'Cut to 10s, keep both lines', tags: ['9:16', '10s', '720p'], finishedAgoMin: 60, actions: [...ACTS] },
  { kind: 'media', id: 'run_q4', aspect: '9/16', tiles: [{ tone: 'var(--c-tone-teal)' }], video: true, durationSec: 15, prompt: 'Same settings as the original', tags: ['9:16', '15s', '480p'], finishedAgoMin: 24 * 60, actions: [...ACTS] },
];

/** Run confirm and result viewer content of the tool designs (QuickCreateConfirm / QuickCreateViewer.dc.html). */
export const toolOverlayDemo = {
  confirm: { meta: 'Auto → Seedance 2.5 · 9:16 · 720p · 15s', balance: 2480, eta: '~2 min', subtitle: 'Auto → Seedance 2.5' },
  viewer: {
    title: 'Two-person product demo · New lighting',
    author: 'Alex',
    prompt: 'In shot 2, change the white daylight outside the window to warm golden-hour light. Keep the action and camera position.',
    /** Label message ids → values. */
    params: [
      ['tools.viewer.model', 'Seedance 2.5'],
      ['tools.viewer.mode', ''],
      ['tools.viewer.aspect', '9:16'],
      ['tools.viewer.duration', '15s'],
      ['tools.viewer.resolution', '720p'],
      ['tools.viewer.seed', '48213'],
      ['tools.viewer.took', '1m 52s'],
      ['tools.viewer.cost', ''],
    ] as Array<[string, string]>,
    cost: 10,
    assets: [
      { id: 'ast_lead', name: '@Lead', tone: 'var(--c-tone-plum)' },
      { id: 'ast_room', name: 'Kitchen set', tone: 'var(--c-tone-teal)' },
    ],
  },
};
