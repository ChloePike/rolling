import { createFileRoute } from '@tanstack/react-router';
import { ProfilePage } from '../../../features/profile/ProfilePage';

export const Route = createFileRoute('/_shell/u/$handle')({
  component: ProfileRoute,
});

function ProfileRoute() {
  const { handle } = Route.useParams();
  return <ProfilePage handle={handle} />;
}
