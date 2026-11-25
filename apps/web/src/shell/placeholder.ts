/** Static placeholder data for the shell until `GET /api/me` lands. Credits live in lib/session (`useCredits`); preferences in lib/prefs. */
export const placeholderAccount = {
  initial: 'A',
};

/** Placeholder project for the Canvas nav item until the projects list exists. */
export const placeholderProjectId = 'prj_demo';

/** Workspaces for the account menu switcher. */
export const placeholderWorkspaces = [
  { id: 'ws_personal', name: 'Personal', kind: 'personal' as const, mark: 'A', tone: 'var(--c-tone-graphite)', members: 1 },
  { id: 'ws_ridgeline', name: 'Ridgeline brand team', kind: 'team' as const, mark: 'R', tone: 'var(--c-tone-fern)', members: 5 },
];

export const placeholderHandle = 'alex';
