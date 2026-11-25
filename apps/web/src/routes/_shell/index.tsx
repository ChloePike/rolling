import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../pages/PageStub';

export const Route = createFileRoute('/_shell/')({
  component: () => <PageStub titleId="page.home.title" hero />,
});
