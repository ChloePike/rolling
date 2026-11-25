import { createFileRoute } from '@tanstack/react-router';
import { AuthStub } from '../pages/AuthStub';

export const Route = createFileRoute('/login')({
  component: () => <AuthStub titleId="page.login.title" />,
});
