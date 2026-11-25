import { createFileRoute, notFound } from '@tanstack/react-router';
import { isSettingsSection, SettingsPage } from '../../../features/account/SettingsPage';

export const Route = createFileRoute('/_shell/settings/$section')({
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) throw notFound();
  },
  component: SettingsRoute,
});

function SettingsRoute() {
  const { section } = Route.useParams();
  return isSettingsSection(section) ? <SettingsPage section={section} /> : null;
}
