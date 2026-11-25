import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/p/$projectId')({
  component: () => <PageStub titleId="page.canvas.title" />,
});
