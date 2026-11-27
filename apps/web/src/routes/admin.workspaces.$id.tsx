import { createFileRoute } from '@tanstack/react-router';
import { WorkspacePage } from '@/features/admin/WorkspacePage';

export const Route = createFileRoute('/admin/workspaces/$id')({ component: AdminWorkspace });

function AdminWorkspace() {
  const { id } = Route.useParams();
  return <WorkspacePage key={id} id={id} />;
}
