import { createFileRoute } from '@tanstack/react-router';
import { PageStub } from '../../../pages/PageStub';

export const Route = createFileRoute('/_shell/create/character')({
  component: () => <PageStub titleId="page.characters.title" />,
});
