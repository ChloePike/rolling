import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/LoginPage';
import { authSearch } from '@/features/auth/search';
import { redirectIfSignedIn } from '@/lib/session/guard';

export const Route = createFileRoute('/signup')({
  validateSearch: authSearch,
  beforeLoad: ({ search }) => redirectIfSignedIn(search.redirect),
  component: () => <LoginPage mode="signup" />,
});
