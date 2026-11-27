import { createFileRoute } from '@tanstack/react-router';
import { CounterNoticePage } from '@/features/trust/DmcaPage';

/** DMCA counter-notice (D-028); signed in, `?case=<id>` from the removal notice. */
export const Route = createFileRoute('/counter-notice')({
  validateSearch: (s: Record<string, unknown>): { case?: string } => (typeof s.case === 'string' && s.case.length <= 80 ? { case: s.case } : {}),
  component: CounterRoute,
});

function CounterRoute() {
  const search = Route.useSearch();
  return <CounterNoticePage {...(search.case ? { caseId: search.case } : {})} />;
}
