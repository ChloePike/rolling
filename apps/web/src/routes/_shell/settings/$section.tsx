import { createFileRoute, notFound } from '@tanstack/react-router';
import { FormattedMessage } from 'react-intl';
import { PageStub } from '../../../pages/PageStub';

const settingsSections = ['account', 'preferences', 'billing', 'team', 'notifications'] as const;
type SettingsSection = (typeof settingsSections)[number];

function isSection(s: string): s is SettingsSection {
  return (settingsSections as readonly string[]).includes(s);
}

export const Route = createFileRoute('/_shell/settings/$section')({
  beforeLoad: ({ params }) => {
    if (!isSection(params.section)) throw notFound();
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { section } = Route.useParams();
  return (
    <PageStub titleId="page.settings.title">
      <h2>
        <FormattedMessage id={`page.settings.section.${section}`} />
      </h2>
    </PageStub>
  );
}
