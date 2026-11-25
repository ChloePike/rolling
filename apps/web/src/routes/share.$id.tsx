import { createFileRoute } from '@tanstack/react-router';
import { SharePage } from '@/features/share/SharePage';

/** Public, read-only share link (`<PUBLIC_APP_URL>/share/<shareId>`). */
export const Route = createFileRoute('/share/$id')({
  component: ShareRoute,
});

function ShareRoute() {
  const { id } = Route.useParams();
  return <SharePage id={id} />;
}
