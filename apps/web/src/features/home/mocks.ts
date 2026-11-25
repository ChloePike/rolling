import type { ProjectSummary } from './types';

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Mock recent projects matching Main.dc.html. */
export const MOCK_PROJECTS: ProjectSummary[] = [
  { id: 'prj_01', title: 'Ridgeline Sparkling · 15s ad', kind: 'canvas', nodeCount: 12, updatedAt: ago(2 * HOUR), tone: '#1F2628' },
  { id: 'prj_02', title: 'Desk organizer pitch', kind: 'avatar', durationSec: 10, updatedAt: ago(26 * HOUR), tone: '#2B2619' },
  { id: 'prj_03', title: 'Two-person product demo', kind: 'quick', durationSec: 15, updatedAt: ago(30 * HOUR), tone: '#26232A' },
  { id: 'prj_04', title: 'Lead · Mia', kind: 'character', updatedAt: ago(72 * HOUR), tone: '#1C2A22' },
];

/** Inspiration placeholder tones (Main.dc.html `tones`). */
export const FEED_TONES = ['#26232A', '#1F2628', '#202330', '#2B2619', '#26262A', '#1C2A22'];
