import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/assets/public')({
  component: () => <PageStub titleId="page.publicLibrary.title" />,
});
