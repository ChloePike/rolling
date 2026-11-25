import { createFileRoute } from '@tanstack/react-router';
import { InvitePage } from '@/features/account/invite/InvitePage';

/** Public invite landing (D-013): `<PUBLIC_APP_URL>/invite/<token>` from the invite email. */
export const Route = createFileRoute('/invite/$token')({
  component: InviteRoute,
});

function InviteRoute() {
  const { token } = Route.useParams();
  return <InvitePage token={token} />;
}
