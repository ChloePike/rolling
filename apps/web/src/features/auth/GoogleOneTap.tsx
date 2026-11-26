import { useToast } from '@rolling/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useIntl } from 'react-intl';
import { useSession } from '@/lib/session';
import { authErrorMessage, fetchProviders } from './api';
import { signInWithGoogleIdToken, useGoogleIdentity } from './google';

/**
 * Google One Tap (D-016) on a public page, for signed-out visitors only: loads
 * Google Identity Services lazily, signs in in place and goes to `redirect`.
 * Renders nothing; a failure shows a toast (the page has no inline slot).
 */
export function GoogleOneTap({ redirect }: { redirect: string }) {
  const session = useSession();
  const signedOut = session.status === 'signedOut';
  const providers = useQuery({ queryKey: ['auth', 'providers'], queryFn: fetchProviders, staleTime: 5 * 60_000, enabled: signedOut });
  const toast = useToast();
  const intl = useIntl();
  const navigate = useNavigate();
  const gis = useGoogleIdentity({
    config: signedOut ? providers.data?.google || null : null,
    redirect,
    oneTap: signedOut,
    onCredential: async (token, nonce) => {
      try {
        const r = await signInWithGoogleIdToken(token, nonce, redirect);
        toast.show({ message: intl.formatMessage({ id: 'auth.toast.signedIn' }) });
        await navigate({ href: r.redirectTo });
      } catch (err) {
        const m = authErrorMessage(err);
        toast.show({ message: intl.formatMessage({ id: m.id }, m.values) });
        gis.refresh();
      }
    },
  });
  return null;
}
