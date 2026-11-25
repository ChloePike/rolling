import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/assets/')({
  component: () => <PageStub titleId="page.assets.title" />,
});
