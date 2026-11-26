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
import { POPUP_PARAM } from '@/lib/upgrade/popup';
import { emitCheckoutResume, pollCheckout, RETURN_PARAMS } from './checkout';
import { isPublicPath } from './guard';
import { refetchMe } from './real';
import { useSession } from './store';

/**
 * Session side effects that need the router and toasts (mounted once in the
 * root route; the mocks only handle the checkout return):
 * - signed out while on an app route (socket 4401, expired cookie) → `/login`;
 * - Stripe returns (`?checkout=success&session_id=…`, `?checkout=canceled`,
 *   `?portal=returned`): poll the outcome, toast, refresh, hand
 *   `resume.runQuoteId` to `onCheckoutResume` listeners, strip the params;
 * - failed preference saves and `notification` messages → toasts.
 */
export function SessionRuntime() {
  // The mocks only handle the checkout return (`__rollingMocks.checkoutRedirect`).
  if (isMockApi()) return <MockRuntime />;
  return <Runtime />;
}

function MockRuntime() {
  useCheckoutReturn();
  return null;
}

function Runtime() {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const location = useRouterState({ select: (s) => s.location });

  // Signed out under an app route.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (session.status === 'signedIn') wasSignedIn.current = true;
    if (session.status !== 'signedOut' || isPublicPath(location.pathname)) return;
    if (wasSignedIn.current) toast.show({ message: intl.formatMessage({ id: 'shell.session.expired' }) });
    wasSignedIn.current = false;
    void navigate({ to: '/login', search: { redirect: location.href }, replace: true });
  }, [session.status, location.pathname, location.href, navigate, toast, intl]);

  useCheckoutReturn();

  // Preference saves the server refused (already rolled back).
  useEffect(() => {
    const onError = (e: Event) => {
      const { error, patch } = (e as CustomEvent<PrefsErrorDetail>).detail;
      // No plan for mature content: the shared API error handler opened the upgrade modal instead.
      if (isApiError(error, 'NO_PLAN') && 'matureContent' in patch) return;
      toast.show({ message: intl.formatMessage({ id: 'shell.prefs.saveFailed' }) });
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

/** Stripe returns (`?checkout=…&session_id=…`, `?portal=returned`): poll, toast, refresh, resume, strip the params. */
function useCheckoutReturn() {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useRouterState({ select: (s) => s.location });
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const checkout = q.get('checkout');
    const sessionId = q.get('session_id');
    const portal = q.get('portal');
    if (!checkout && !portal) return;
    // The checkout popup's own return page: the opener handles it (lib/upgrade/popup.ts).
    if (q.get(POPUP_PARAM) === '1') return;
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
        // The mock return (`__rollingMocks.checkoutRedirect`) applied the plan itself.
        if (!isMockApi()) {
          await refetchMe();
          void queryClient.invalidateQueries({ queryKey: ['billing'] });
          void queryClient.invalidateQueries({ queryKey: ['workspace'] });
        }
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

}
