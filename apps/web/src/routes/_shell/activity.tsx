import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../pages/PageStub';

export const Route = createFileRoute('/_shell/activity')({
  component: () => <PageStub titleId="page.activity.title" />,
});
