import { createFileRoute } from '@tanstack/react-router';
import { ReportPage } from '@/features/trust/ReportPage';

/** Public abuse report form (D-026); `?kind=share|profile&id=…` from the Report action. */
export const Route = createFileRoute('/report')({
  validateSearch: (s: Record<string, unknown>): { kind?: 'share' | 'profile'; id?: string } => ({
    ...(s.kind === 'share' || s.kind === 'profile' ? { kind: s.kind } : {}),
    ...(typeof s.id === 'string' && s.id.length <= 120 ? { id: s.id } : {}),
  }),
  component: ReportRoute,
});

function ReportRoute() {
  const search = Route.useSearch();
  return <ReportPage target={search} />;
}
