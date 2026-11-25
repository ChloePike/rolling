import { createFileRoute } from '@tanstack/react-router';
import { AuthStub } from '../pages/AuthStub';

export const Route = createFileRoute('/signup')({
  component: () => <AuthStub titleId="page.signup.title" />,
});
