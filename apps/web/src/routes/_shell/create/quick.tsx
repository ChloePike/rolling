import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/create/quick')({
  component: () => <PageStub titleId="page.quickCreate.title" />,
});
