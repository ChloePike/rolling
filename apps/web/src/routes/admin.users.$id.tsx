import { createFileRoute } from '@tanstack/react-router';
import { UserPage } from '@/features/admin/UserPage';

export const Route = createFileRoute('/admin/users/$id')({ component: AdminUser });

function AdminUser() {
  const { id } = Route.useParams();
  return <UserPage key={id} id={id} />;
}
