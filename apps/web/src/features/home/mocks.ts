import type { ProjectSummary } from './types';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Mock recent projects matching Main.dc.html. */
export const MOCK_PROJECTS: ProjectSummary[] = [
  { id: 'prj_01', title: 'Ridgeline Sparkling · 15s ad', kind: 'canvas', nodeCount: 12, updatedAt: ago(2 * HOUR), tone: 'var(--c-tone-teal)' },
  { id: 'prj_02', title: 'Desk organizer pitch', kind: 'avatar', durationSec: 10, updatedAt: ago(26 * HOUR), tone: 'var(--c-tone-ochre)' },
  { id: 'prj_03', title: 'Two-person product demo', kind: 'quick', durationSec: 15, updatedAt: ago(30 * HOUR), tone: 'var(--c-tone-plum)' },
  { id: 'prj_04', title: 'Lead · Mia', kind: 'character', updatedAt: ago(72 * HOUR), tone: 'var(--c-tone-pine)' },
];

const est = (credits: number) => ({ credits, items: [], applyIsFree: true as const, balanceAfter: 2480 - credits, needsConfirm: credits >= 300 });
const shot = (n: number, title: string, seconds: number, visual: string, credits: number) => ({ n, title, seconds, visual, model: 'bytedance/seedance-2.5', mode: 'i2v' as const, resolution: '720p', credits });

/** Mock agent reply to a brief on Home (`propose.plan`, 2 options). */
export const MOCK_HOME_PLAN = {
  text: 'Two directions for a 15-second vertical spot. Building the nodes is free; the estimate is what running them costs.',
  options: [
    {
      title: 'Morning ritual',
      ratio: '9:16',
      resolution: '720p',
      seconds: 15,
      estimate: est(26),
      ops: [],
      shots: [shot(1, 'Pour', 5, 'Close-up of water poured into a glass, morning light', 8), shot(2, 'Sip', 5, 'A person takes the first sip by a window', 8), shot(3, 'Bottle', 5, 'The bottle on a wet stone counter, slow push-in', 10)],
    },
    {
      title: 'City heat',
      ratio: '9:16',
      resolution: '720p',
      seconds: 15,
      estimate: est(24),
      ops: [],
      shots: [shot(1, 'Street', 5, 'Hot street at noon, heat haze', 8), shot(2, 'Open', 5, 'A can opens in slow motion', 8), shot(3, 'Relief', 5, 'A runner drinks in the shade', 8)],
    },
  ],
};

/** Mock agent reply to small talk (no tools, a nudge toward a brief). */
export const MOCK_HOME_SMALL_TALK = 'Hi. Tell me what the video is for, how long it should be and whether it is vertical or widescreen, and I will plan the shots.';
