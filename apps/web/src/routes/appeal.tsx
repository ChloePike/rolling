import { createFileRoute } from '@tanstack/react-router';
import { AppealPage } from '@/features/trust/AppealPage';

/** Appeal a suspension or a blocked run (D-028); signed in. */
export const Route = createFileRoute('/appeal')({
  validateSearch: (s: Record<string, unknown>): { run?: string } => (typeof s.run === 'string' && s.run.length <= 80 ? { run: s.run } : {}),
  component: AppealRoute,
});

function AppealRoute() {
  const { run } = Route.useSearch();
  return <AppealPage {...(run ? { runId: run } : {})} />;
}
