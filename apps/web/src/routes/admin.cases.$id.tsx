import { createFileRoute } from '@tanstack/react-router';
import { CasePage } from '@/features/admin/CasePage';

export const Route = createFileRoute('/admin/cases/$id')({ component: AdminCase });

function AdminCase() {
  const { id } = Route.useParams();
  return <CasePage key={id} id={id} />;
}
