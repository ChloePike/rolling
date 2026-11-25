import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '../features/auth/LoginPage';

export const Route = createFileRoute('/signup')({
  component: () => <LoginPage mode="signup" />,
});
