import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/create/avatar')({
  component: () => <PageStub titleId="page.avatar.title" />,
});
