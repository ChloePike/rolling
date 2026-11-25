import { useToast } from '@rolling/ui';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { PLANS, type PlanId } from '@rolling/core/pricing/config';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import { queryClient } from '@/lib/api/queryClient';
import { PREFS_ERROR_EVENT, type PrefsErrorDetail } from '@/lib/prefs';
import { useUserSocketEvent } from '@/lib/realtime';
import { emitCheckoutResume, pollCheckout, RETURN_PARAMS } from './checkout';
import { isPublicPath } from './guard';
import { refetchMe } from './real';
import { useSession } from './store';

/**
 * Session side effects that need the router and toasts (mounted once in the
 * root route, real API only):
 * - signed out while on an app route (socket 4401, expired cookie) → `/login`;
 * - Stripe returns (`?checkout=success&session_id=…`, `?checkout=canceled`,
 *   `?portal=returned`): poll the outcome, toast, refresh, hand
 *   `resume.runQuoteId` to `onCheckoutResume` listeners, strip the params;
 * - failed preference saves and `notification` messages → toasts.
 */
export function SessionRuntime() {
  if (isMockApi()) return null;
  return <Runtime />;
}

function Runtime() {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const location = useRouterState({ select: (s) => s.location });
  const handled = useRef(new Set<string>());

  // Signed out under an app route.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (session.status === 'signedIn') wasSignedIn.current = true;
    if (session.status !== 'signedOut' || isPublicPath(location.pathname)) return;
    if (wasSignedIn.current) toast.show({ message: intl.formatMessage({ id: 'shell.session.expired' }) });
    wasSignedIn.current = false;
    void navigate({ to: '/login', search: { redirect: location.href }, replace: true });
  }, [session.status, location.pathname, location.href, navigate, toast, intl]);

  // Stripe returns.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const checkout = q.get('checkout');
    const sessionId = q.get('session_id');
    const portal = q.get('portal');
    if (!checkout && !portal) return;
    const key = `${checkout}:${sessionId}:${portal}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);
    const strip = () => {
      const next = new URLSearchParams(window.location.search);
      for (const k of RETURN_PARAMS) next.delete(k);
      const s = next.toString();
      void navigate({ href: `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`, replace: true });
    };
    if (portal) {
      strip();
      void refetchMe();
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
      return;
    }
    if (checkout === 'canceled') {
      strip();
      toast.show({ message: intl.formatMessage({ id: 'shell.checkout.canceled' }) });
      return;
    }
    if (checkout !== 'success' || !sessionId) return strip();
    strip();
    void pollCheckout(sessionId)
      .then(async (outcome) => {
        await refetchMe();
        void queryClient.invalidateQueries({ queryKey: ['billing'] });
        void queryClient.invalidateQueries({ queryKey: ['workspace'] });
        if (outcome.status !== 'complete') {
          toast.show({ message: intl.formatMessage({ id: outcome.status === 'expired' ? 'shell.checkout.expired' : 'shell.checkout.pending' }), duration: 8000 });
          return;
        }
        const plan = outcome.planId ? (PLANS[outcome.planId as PlanId]?.label ?? outcome.planId) : '';
        toast.show({
          message:
            outcome.kind === 'topUp'
              ? intl.formatMessage({ id: 'shell.checkout.topUpDone' }, { credits: outcome.credits ?? 0 })
              : intl.formatMessage({ id: 'shell.checkout.planDone' }, { plan }),
        });
        emitCheckoutResume({ outcome, runQuoteId: outcome.resume?.runQuoteId ?? null });
      })
      .catch(() => toast.show({ message: intl.formatMessage({ id: 'shell.checkout.pending' }), duration: 8000 }));
  }, [location.searchStr, navigate, toast, intl]);

  // Preference saves the server refused (already rolled back).
  useEffect(() => {
    const onError = (e: Event) => {
      const { error, patch } = (e as CustomEvent<PrefsErrorDetail>).detail;
      const id = isApiError(error, 'NO_PLAN') && 'matureContent' in patch ? 'shell.prefs.matureNeedsPlan' : 'shell.prefs.saveFailed';
      toast.show({ message: intl.formatMessage({ id }) });
    };
    window.addEventListener(PREFS_ERROR_EVENT, onError);
    return () => window.removeEventListener(PREFS_ERROR_EVENT, onError);
  }, [toast, intl]);

  useUserSocketEvent('notification', (p) => {
    const message = p.message ?? p.title;
    if (message) toast.show({ message, duration: 6000 });
  });

  return null;
}
