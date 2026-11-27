import { createFileRoute, redirect } from '@tanstack/react-router';
import { englishMessages } from '@/i18n/messages';

/**
 * `/canvas`: the sidebar Canvas item. Opens the last canvas this user opened
 * in this workspace, else the most recently updated project, else a new blank
 * canvas (owner decision). It resolves in `beforeLoad`, so the current page
 * stays on screen until the redirect (no flash of a not-found canvas); hover
 * preloads warm the projects query and never create anything.
 */
export const Route = createFileRoute('/canvas')({
  beforeLoad: async ({ preload }) => {
    // Imported here, not at the top: route options stay in the entry chunk (bundle splitting).
    const target = await import('@/features/canvas/target/projects')
      .then(({ resolveNavCanvas }) => resolveNavCanvas({ untitled: englishMessages['home.project.untitled'] ?? 'Untitled project', preload }))
      .catch(() => ({ kind: 'none' }) as const);
    if (preload) return;
    if (target.kind === 'open') throw redirect({ to: '/p/$projectId', params: { projectId: target.projectId }, replace: true });
    // Nothing to open and nothing we may create (a viewer with no projects, or offline): Home's projects.
    throw redirect({ to: '/', hash: 'projects', replace: true });
  },
  component: () => null,
});
