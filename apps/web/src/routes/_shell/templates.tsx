import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../pages/PageStub';

export const Route = createFileRoute('/_shell/templates')({
  component: () => <PageStub titleId="page.templates.title" />,
});
