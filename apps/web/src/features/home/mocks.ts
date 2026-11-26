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
