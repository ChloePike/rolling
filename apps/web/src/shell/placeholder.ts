/** Static placeholder data for the M0 shell. Replaced by API data in M1+. */
export const placeholderAccount = {
  initial: 'A',
  creditBalance: 2480,
  currency: 'USD',
  defaultAspectRatio: '9:16',
  notifyWhenDone: true,
};

/** Placeholder project for the Canvas nav item until the projects list exists. */
export const placeholderProjectId = 'prj_demo';

/** Credits breakdown for the header credits popover (Main.dc.html). Replaced by GET /api/credits. */
export const placeholderCredits = {
  available: 2480,
  plan: 1800,
  planExpires: new Date(2026, 10, 30),
  purchased: 680,
  usedThisMonth: 1284,
  held: 16,
  expiringThisMonth: 300,
  packs: [1000, 3000, 10000],
  defaultPack: 3000,
};

/** Workspaces for the account menu switcher. */
export const placeholderWorkspaces = [
  { id: 'ws_personal', name: 'Personal', kind: 'personal' as const, mark: 'A', tone: '#333338', members: 1 },
  { id: 'ws_ridgeline', name: 'Ridgeline brand team', kind: 'team' as const, mark: 'R', tone: '#2B3A33', members: 5 },
];

export const placeholderHandle = 'alex';
