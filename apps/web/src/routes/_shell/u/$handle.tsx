import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/u/$handle')({
  component: ProfilePage,
});

function ProfilePage() {
  const { handle } = Route.useParams();
  return <PageStub titleId="page.profile.title" values={{ handle }} />;
}
