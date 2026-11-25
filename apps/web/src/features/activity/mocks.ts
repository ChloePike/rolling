import type { ActivityData } from './types';

const MINIMAX_DOWN = 'MiniMax H3 is temporarily unavailable. Nothing was generated. Try again with Seedance 2.5';

/** Same rows as docs/design/screens/Tasks.dc.html. */
export const activityMock: ActivityData = {
  stats: {
    usedThisMonth: 1284,
    usedChange: -0.12,
    running: 2,
    runningEtaMinutes: 3,
    successRate: 0.94,
    runsLast7Days: 128,
    refunded: 86,
  },
  runs: [
    { id: 'run_90412', ref: 'T-90412', name: 'Shot B · Cap pop', source: 'canvas', projectTitle: 'Ridgeline Sparkling', params: 'Seedance 2.5 · 720p · 5s', status: 'running', progress: 0.58, credits: 8, refunded: 0, minutesAgo: 0 },
    { id: 'run_90413', ref: 'T-90413', name: 'Shot C · Logo', source: 'canvas', projectTitle: 'Ridgeline Sparkling', params: 'Seedance 2.5 · 720p · 5s', status: 'queued', credits: 8, refunded: 0, minutesAgo: 0 },
    { id: 'run_90398', ref: 'T-90398', name: 'Talking head · Desk organizer', source: 'avatar', params: 'MiniMax H3 · 9:16 · 10s', status: 'done', credits: 12, refunded: 0, minutesAgo: 10 },
    { id: 'run_90377', ref: 'T-90377', name: 'Two-person product demo · New lighting', source: 'quickCreate', params: 'Seedance 2.5 · 720p · 15s', status: 'done', credits: 10, refunded: 0, minutesAgo: 24 },
    { id: 'run_90351', ref: 'T-90351', name: 'Product keyframe × 4', source: 'canvas', projectTitle: 'Ridgeline Sparkling', params: 'Seedream 5.0 Pro · 2K × 4', status: 'partial', credits: 6, refunded: 2, minutesAgo: 60 },
    { id: 'run_90302', ref: 'T-90302', name: 'Two-person original · Table demo', source: 'remix', params: 'MiniMax H3 · 1080p · 10s', status: 'failed', credits: 0, refunded: 20, error: MINIMAX_DOWN, minutesAgo: 120 },
    { id: 'run_90288', ref: 'T-90288', name: 'Lead · Mia', source: 'characters', params: 'Seedream 5.0 Pro · 2K · 2 views', status: 'done', credits: 4, refunded: 0, minutesAgo: 180 },
    { id: 'run_90210', ref: 'T-90210', name: 'Shot A · Hero shot v1', source: 'canvas', projectTitle: 'Ridgeline Sparkling', params: 'Seedance 2.5 · 720p · 5s', status: 'review', credits: 8, refunded: 0, minutesAgo: 60 * 26 },
    { id: 'run_90155', ref: 'T-90155', name: 'Holiday gift · New lines', source: 'quickCreate', params: 'Wan 2.2 · 480p · 15s', status: 'canceled', credits: 0, refunded: 0, minutesAgo: 60 * 30 },
  ],
};
