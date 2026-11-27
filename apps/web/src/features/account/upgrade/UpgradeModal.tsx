import { PLANS, type PlanId } from '@rolling/core/pricing/config';
import { cx, Dialog, staggerStyle } from '@rolling/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { PaywallPanel } from '@/features/overlays/Paywall';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import { queryClient } from '@/lib/api/queryClient';
import { formatPrice, usePref } from '@/lib/prefs';
import {
  checkoutPlan,
  checkoutTopUp,
  currentReturnPath,
  emitCheckoutResume,
  getSession,
  pollCheckout,
  redirectTo,
  refetchMe,
  startCheckout,
  startPortal,
  toInterval,
  useCredits,
  useSession,
  type BillingPeriod,
} from '@/lib/session';
import type { CheckoutOutcome } from '@/lib/api/types';
import { mocks } from '@/lib/session/seams';
import {
  closeUpgrade,
  installPlanErrorHandler,
  isUnlockedBy,
  navigateCheckoutWindow,
  offeredPlans,
  onPopupReturn,
  openCheckoutWindow,
  popupReturnPath,
  preselectedPlan,
  requiredPlan,
  teamSeatsFor,
  upgradeVariant,
  useUpgrade,
  type UpgradeReason,
  type UpgradeRequest,
} from '@/lib/upgrade';
import { motion, PathIcon, paths, Segmented } from '../shared';
import { SeatStepper, TeamGets, TeamPriceBreakdown } from '../team/TeamPricing';
import styles from './UpgradeModal.module.css';

/** How long "You're on Plus" stays before the interrupted action continues (Continue skips it). */
const SUCCESS_MS = 1600;

/**
 * Mounted once in the root route: the shared upgrade modal (`openUpgrade`)
 * plus the shared API error handler (plan errors on commands open it).
 */
export function UpgradeHost() {
  useEffect(() => installPlanErrorHandler(), []);
  const request = useUpgrade();
  // Keep the last request rendered while the dialog animates out.
  const last = useRef<UpgradeRequest | null>(null);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return shown ? <UpgradeModal key={shown.id} request={shown} open={!!request && request.id === shown.id} /> : null;
}

type Phase =
  | { kind: 'choose'; note?: string }
  | { kind: 'pending' }
  | { kind: 'waiting'; sessionId: string | null; portal: boolean; note?: string }
  | { kind: 'success'; plan: PlanId | null; seats: number; credits: number | null; outcome: CheckoutOutcome }
  | { kind: 'unavailable' };

/** `GET /api/billing/plans` → `paymentsEnabled` (false until Stripe is configured). */
function usePaymentsEnabled(open: boolean): boolean | null {
  const mock = isMockApi();
  const q = useQuery({
    queryKey: ['billing', 'plans'],
    queryFn: () => api.get<{ paymentsEnabled?: boolean }>('/billing/plans', { noWorkspace: true }),
    enabled: open && !mock,
    staleTime: 5 * 60_000,
  });
  if (mock) return mocks().payments !== 'off';
  if (!q.data) return null;
  return q.data.paymentsEnabled !== false;
}

function mockOutcome(kind: 'plan' | 'topUp', plan: PlanId | null, period: BillingPeriod, seats: number, credits: number | null): CheckoutOutcome {
  return {
    sessionId: `upgrade_${Date.now().toString(36)}`,
    kind,
    status: 'complete',
    planId: plan,
    interval: kind === 'plan' ? toInterval(period) : null,
    amountCents: null,
    credits,
    completedAt: Date.now(),
    seats: plan === 'team' ? seats : null,
    resume: null,
  };
}

/** Name values for the reason's copy. */
function reasonValues(reason: UpgradeReason, plan: PlanId): Record<string, string | number> {
  const label = PLANS[plan].label;
  switch (reason.kind) {
    case 'resolution':
      return { value: reason.value, plan: label };
    case 'model':
      return { name: reason.name ?? reason.id, plan: label };
    case 'count':
    case 'duration':
      return { n: reason.value, plan: label };
    default:
      return { plan: label };
  }
}

const SUCCESS_KEY: Partial<Record<UpgradeReason['kind'], string>> = {
  resolution: 'resolution',
  model: 'model',
  agent: 'agent',
  generate: 'generate',
  mature: 'mature',
};

export function UpgradeModal({ request, open }: { request: UpgradeRequest; open: boolean }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const session = useSession();
  const credits = useCredits();
  usePref('currency');
  const { reason } = request;
  const titleId = useId();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const money = (usd: number) => formatPrice(intl, usd, 'USD');

  // What the modal offers is fixed when it opens (the session may change under it after paying).
  const [initial] = useState(() => ({ plan: session.planId, member: session.isMember }));
  const variant = upgradeVariant(reason, initial.plan);
  const offered = useMemo(() => offeredPlans(reason, initial.plan), [reason, initial.plan]);
  const required = requiredPlan(reason);
  const [period, setPeriod] = useState<BillingPeriod>(session.plan?.period ?? 'monthly');
  const [plan, setPlan] = useState<PlanId>(() => preselectedPlan(reason, initial.plan));
  const team = teamSeatsFor(reason);
  const [seats, setSeats] = useState(() => (initial.plan === 'team' ? Math.max(team.seats, session.seats) : team.seats));
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [error, setError] = useState<string | null>(null);
  const payments = usePaymentsEnabled(open);
  const unavailable = phase.kind === 'unavailable' || (payments === false && phase.kind !== 'success');

  // Finishing: the action that was interrupted continues, and hosts waiting on a checkout take their pending action.
  const done = useRef(false);
  const finish = useCallback(
    (outcome: CheckoutOutcome) => {
      if (done.current) return;
      done.current = true;
      closeUpgrade({ resumed: true, id: request.id });
      emitCheckoutResume({ outcome, runQuoteId: outcome.resume?.runQuoteId ?? null });
    },
    [request.id],
  );
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onOpenChange = useCallback(
    (o: boolean) => {
      if (o) return;
      const p = phaseRef.current;
      if (p.kind === 'success') return finish(p.outcome);
      closeUpgrade({ id: request.id });
    },
    [finish, request.id],
  );

  const succeed = useCallback(
    (outcome: CheckoutOutcome) => {
      if (!isMockApi()) {
        void queryClient.invalidateQueries({ queryKey: ['billing'] });
        void queryClient.invalidateQueries({ queryKey: ['workspace'] });
      }
      const s = getSession();
      setError(null);
      setPhase({ kind: 'success', plan: (outcome.planId as PlanId | null) ?? s.planId, seats: outcome.seats ?? s.seats, credits: outcome.credits, outcome });
    },
    [],
  );

  useEffect(() => {
    if (phase.kind !== 'success') return;
    const timer = window.setTimeout(() => finish(phase.outcome), SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [phase, finish]);

  /** Real mode, waiting on the popup: check the session (the popup message, window focus, Check again). */
  const confirm = useCallback(
    async (sessionId: string | null) => {
      try {
        if (sessionId) {
          const outcome = await pollCheckout(sessionId, { timeoutMs: 20_000 });
          await refetchMe();
          if (outcome.status === 'complete') return succeed(outcome);
          if (outcome.status === 'expired') return setPhase({ kind: 'choose', note: t('account.upgradeModal.error.expired') });
        } else await refetchMe();
      } catch {
        /* Keep waiting. */
      }
      const s = getSession();
      if (isUnlockedBy(reason, s.planId)) return succeed(mockOutcome('plan', s.planId, period, s.seats, null));
      const p = phaseRef.current;
      if (p.kind === 'waiting') setPhase({ ...p, note: t('account.upgradeModal.waiting.unchanged') });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reason, period, succeed],
  );

  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const ours = phase;
    const off = onPopupReturn((r) => {
      if (phaseRef.current.kind !== 'waiting') return;
      if (r.checkout === 'canceled') return setPhase({ kind: 'choose', note: t('account.upgradeModal.error.canceled') });
      if (r.portal && ours.portal) return void confirm(null);
      if (r.checkout === 'success' && (!ours.sessionId || r.sessionId === ours.sessionId)) {
        void confirm(r.sessionId);
      }
    });
    const onFocus = () => {
      if (phaseRef.current.kind === 'waiting') void confirm(null);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, confirm]);

  function failed(e: unknown) {
    if (isApiError(e) && e.status === 503) return setPhase({ kind: 'unavailable' });
    setPhase({ kind: 'choose' });
    setError(
      t(
        isApiError(e, 'FORBIDDEN')
          ? 'account.upgradeModal.error.ownerOnly'
          : isApiError(e, 'PAYMENT_FAILED')
            ? 'account.upgradeModal.error.payment'
            : isApiError(e, 'SEATS_REQUIRED')
              ? 'account.team.start.seatsRequired'
              : 'account.upgradeModal.error.failed',
        { n: team.min },
      ),
    );
  }

  /** Plan or Team checkout. Mock: in place. Real: Stripe in a popup (same-tab redirect when blocked). */
  async function pay(target: PlanId) {
    if (session.status === 'signedOut') {
      closeUpgrade({ id: request.id });
      return void navigate({ to: '/signup', search: { redirect: currentReturnPath() } as never });
    }
    if (payments === false) return setPhase({ kind: 'unavailable' });
    setError(null);
    const n = target === 'team' ? seats : 1;
    if (isMockApi()) {
      setPhase({ kind: 'pending' });
      try {
        const s = await checkoutPlan(target, period, n);
        return succeed(mockOutcome('plan', s.planId ?? target, period, n, null));
      } catch (e) {
        return failed(e);
      }
    }
    // Synchronously from the click, so popup blockers let it through.
    const w = openCheckoutWindow();
    const returnTo = w ? popupReturnPath('/upgrade') : currentReturnPath();
    setPhase({ kind: 'pending' });
    try {
      // A live personal plan changes in the Stripe portal (prorations); Team and new plans use Checkout.
      if (initial.member && initial.plan !== 'team' && target !== 'team') {
        const url = await startPortal(returnTo);
        if (!w) return redirectTo(url);
        navigateCheckoutWindow(w, url);
        return setPhase({ kind: 'waiting', sessionId: null, portal: true });
      }
      const r = await startCheckout({ kind: 'plan', planId: target, period, seats: n }, returnTo);
      if (r.switched) {
        w?.close();
        return succeed(mockOutcome('plan', target, period, n, null));
      }
      if (!w) return redirectTo(r.url);
      navigateCheckoutWindow(w, r.url);
      setPhase({ kind: 'waiting', sessionId: r.sessionId, portal: false });
    } catch (e) {
      w?.close();
      failed(e);
    }
  }

  /** Members out of credits: any-amount top-up (same popup flow). */
  async function topUp(amountUsd: number) {
    if (payments === false) return setPhase({ kind: 'unavailable' });
    setError(null);
    if (isMockApi()) {
      setPhase({ kind: 'pending' });
      try {
        const r = await checkoutTopUp(amountUsd);
        return succeed(mockOutcome('topUp', null, period, 1, r.credits));
      } catch (e) {
        return failed(e);
      }
    }
    const w = openCheckoutWindow();
    setPhase({ kind: 'pending' });
    try {
      const r = await startCheckout({ kind: 'topUp', amountUsd }, w ? popupReturnPath('/upgrade') : currentReturnPath());
      if (r.switched) return;
      if (!w) return redirectTo(r.url);
      navigateCheckoutWindow(w, r.url);
      setPhase({ kind: 'waiting', sessionId: r.sessionId, portal: false });
    } catch (e) {
      w?.close();
      failed(e);
    }
  }

  const values = reasonValues(reason, variant === 'team' ? 'team' : required === 'team' ? 'pro' : required);
  const pending = phase.kind === 'pending';

  /** The headline and line under it for the reason the modal opened (the same copy the offer shows). */
  const reasonHead = (): { title: string; sub: string } => {
    if (variant === 'topUp') return { title: t('overlays.paywall.credits.title'), sub: t('overlays.paywall.credits.sub') };
    if (variant === 'team') {
      return reason.kind === 'team-invite'
        ? { title: t('account.team.start.title'), sub: t('account.team.start.lead') }
        : { title: t('account.upgradeModal.title.team'), sub: t('account.upgradeModal.sub.team') };
    }
    const titleKey = reason.kind === 'plan' && initial.member ? 'upgrade' : reason.kind;
    return { title: t(`account.upgradeModal.title.${titleKey}`, values), sub: t(`account.upgradeModal.sub.${reason.kind === 'plan' ? 'plan' : reason.kind}`, values) };
  };

  let body: React.ReactNode;
  let label: string;
  if (phase.kind === 'success') {
    const isTopUp = phase.outcome.kind === 'topUp';
    const title = isTopUp
      ? t('account.upgradeModal.success.topUp', { credits: phase.credits ?? 0 })
      : phase.plan === 'team'
        ? t('account.team.toast.started', { n: phase.seats })
        : t('account.upgradeModal.success.title', { plan: phase.plan ? PLANS[phase.plan].label : '' });
    const key = SUCCESS_KEY[reason.kind];
    const sub = isTopUp
      ? t('account.upgradeModal.success.topUpSub')
      : key
        ? t(`account.upgradeModal.success.${key}`, values)
        : t('account.upgradeModal.success.other', { credits: phase.plan ? PLANS[phase.plan].monthlyCredits : 0 });
    label = title;
    body = (
      <div className={styles.panel} data-testid="upgrade-modal" data-phase="success">
        <Head titleId={titleId} title={title} sub={sub} onClose={() => onOpenChange(false)} closeLabel={t('account.upgradeModal.close')} icon />
        <button type="button" className={cx(styles.cta, motion.press)} onClick={() => finish(phase.outcome)}>
          <FormattedMessage id="account.upgradeModal.success.continue" />
        </button>
      </div>
    );
  } else if (unavailable) {
    // Payments are off here: the headline still says why the modal opened; the notice under it says why it can't go on.
    const head = reasonHead();
    label = head.title;
    body = (
      <div className={styles.panel} data-testid="upgrade-modal" data-phase="unavailable">
        <Head titleId={titleId} title={head.title} sub={head.sub} onClose={() => onOpenChange(false)} closeLabel={t('account.upgradeModal.close')} />
        <div className={styles.notice} role="status" data-testid="upgrade-unavailable">
          <p className={styles.noticeTitle}>
            <FormattedMessage id="account.upgradeModal.unavailable.title" />
          </p>
          <p className={styles.noticeText}>
            <FormattedMessage id="account.upgradeModal.unavailable.sub" />
          </p>
        </div>
        <button type="button" className={cx(styles.cta, styles.ctaQuiet, motion.press)} onClick={() => onOpenChange(false)}>
          <FormattedMessage id="account.upgradeModal.close" />
        </button>
      </div>
    );
  } else if (phase.kind === 'waiting') {
    label = t('account.upgradeModal.waiting.title');
    body = (
      <div className={styles.panel} data-testid="upgrade-modal" data-phase="waiting">
        <Head titleId={titleId} title={label} sub={t('account.upgradeModal.waiting.sub')} onClose={() => onOpenChange(false)} closeLabel={t('account.upgradeModal.close')} />
        {phase.note && (
          <p className={styles.note} role="status">
            {phase.note}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setPhase({ kind: 'choose' })}>
            <FormattedMessage id="account.upgradeModal.waiting.back" />
          </button>
          <button type="button" className={cx(styles.btn, styles.btnPrimary, motion.press)} onClick={() => void confirm(phase.sessionId)}>
            <FormattedMessage id="account.upgradeModal.waiting.check" />
          </button>
        </div>
      </div>
    );
  } else if (variant === 'topUp') {
    label = t('overlays.paywall.credits.title');
    body = (
      <div data-testid="upgrade-modal" data-phase={phase.kind} data-variant="topUp">
        <PaywallPanel
          variant="credits"
          titleId={titleId}
          runCost={reason.kind === 'top-up' ? (reason.needed ?? 0) : 0}
          balance={reason.kind === 'top-up' && reason.balance !== undefined ? reason.balance : credits.available}
          plan={session.planId}
          busy={pending}
          onClose={() => onOpenChange(false)}
          onContinue={(o) => void topUp(o.amountUsd ?? 0)}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
    );
  } else if (variant === 'team') {
    label = t(reason.kind === 'team-invite' ? 'account.team.start.title' : 'account.upgradeModal.title.team');
    body = (
      <div className={styles.panel} data-testid="upgrade-modal" data-phase={phase.kind} data-variant="team" data-plan="team">
        <Head
          titleId={titleId}
          title={label}
          sub={t(reason.kind === 'team-invite' ? 'account.team.start.lead' : 'account.upgradeModal.sub.team')}
          onClose={() => onOpenChange(false)}
          closeLabel={t('account.upgradeModal.close')}
          note={phase.kind === 'choose' ? phase.note : undefined}
        />
        <Period period={period} onChange={setPeriod} />
        <SeatStepper
          value={seats}
          min={team.min}
          onChange={setSeats}
          hint={team.min > 1 ? <FormattedMessage id="account.team.start.inUse" values={{ n: team.min }} /> : undefined}
        />
        <TeamPriceBreakdown seats={seats} period={period} />
        <TeamGets seats={seats} />
        <p className={styles.small}>
          <FormattedMessage id="account.team.start.note" />
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => onOpenChange(false)} disabled={pending}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button type="button" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={pending} aria-busy={pending || undefined} onClick={() => void pay('team')}>
            <FormattedMessage id={pending ? 'account.team.cta.pending' : 'account.team.start.continue'} />
          </button>
        </div>
      </div>
    );
  } else {
    const titleKey = reason.kind === 'plan' && initial.member ? 'upgrade' : reason.kind;
    label = t(`account.upgradeModal.title.${titleKey}`, values);
    const cur = PLANS[plan];
    const priceUsd = Number(period === 'yearly' ? cur.priceYearlyUsd : cur.priceMonthlyUsd);
    const portal = !isMockApi() && initial.member && initial.plan !== 'team';
    body = (
      <div className={styles.panel} data-testid="upgrade-modal" data-phase={phase.kind} data-variant="personal" data-plan={plan}>
        <Head
          titleId={titleId}
          title={label}
          sub={t(`account.upgradeModal.sub.${reason.kind === 'plan' ? 'plan' : reason.kind}`, values)}
          onClose={() => onOpenChange(false)}
          closeLabel={t('account.upgradeModal.close')}
          note={phase.kind === 'choose' ? phase.note : undefined}
        />
        <Period period={period} onChange={setPeriod} />
        <PlanOptions plans={offered} value={plan} onChange={setPlan} period={period} money={money} />
        <Perks plan={plan} />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button type="button" className={cx(styles.cta, motion.press)} disabled={pending} aria-busy={pending || undefined} onClick={() => void pay(plan)}>
          {pending ? (
            <FormattedMessage id="account.upgradeModal.cta.pending" />
          ) : (
            <FormattedMessage id={portal ? 'account.upgradeModal.cta.portal' : 'account.upgradeModal.cta'} values={{ plan: cur.label, price: money(priceUsd) }} />
          )}
        </button>
        <div className={styles.foot}>
          <span>
            <FormattedMessage id="account.upgradeModal.foot" />
          </span>
          <Link to="/upgrade" className={styles.link} onClick={() => closeUpgrade({ id: request.id })}>
            <FormattedMessage id="account.upgradeModal.compare" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} bare label={label} labelledBy={titleId} dismissOnBackdrop={!pending}>
      {body}
    </Dialog>
  );
}

function Head({ titleId, title, sub, onClose, closeLabel, note, icon }: { titleId: string; title: string; sub: string; onClose: () => void; closeLabel: string; note?: string; icon?: boolean }) {
  return (
    <>
      <div className={styles.head}>
        {icon && (
          <span className={styles.doneIcon} aria-hidden="true">
            <PathIcon d={paths.check} size={18} strokeWidth={2.6} />
          </span>
        )}
        <div className={styles.headText}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <p className={styles.sub}>{sub}</p>
        </div>
        <button type="button" className={styles.close} aria-label={closeLabel} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18 M6 6l12 12" />
          </svg>
        </button>
      </div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </>
  );
}

function Period({ period, onChange }: { period: BillingPeriod; onChange: (p: BillingPeriod) => void }) {
  const intl = useIntl();
  const discount = Math.max(...Object.values(PLANS).map((p) => Number(p.yearlyDiscount) || 0));
  return (
    <Segmented<BillingPeriod>
      label={intl.formatMessage({ id: 'account.upgrade.period' })}
      value={period}
      onChange={onChange}
      className={styles.seg}
      optionClassName={styles.segOption}
      indicatorClassName={styles.segFill}
      options={[
        { value: 'monthly', label: intl.formatMessage({ id: 'account.upgrade.period.monthly' }) },
        {
          value: 'yearly',
          label: (
            <>
              {intl.formatMessage({ id: 'account.upgrade.period.yearly' })}
              <span className={styles.save}>
                <FormattedMessage id="account.upgrade.period.save" values={{ pct: discount }} />
              </span>
            </>
          ),
        },
      ]}
    />
  );
}

function PlanOptions({ plans, value, onChange, period, money }: { plans: PlanId[]; value: PlanId; onChange: (p: PlanId) => void; period: BillingPeriod; money: (usd: number) => string }) {
  const intl = useIntl();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + plans.length) % plans.length;
    onChange(plans[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={intl.formatMessage({ id: 'account.upgradeModal.group' })} className={styles.options}>
      {plans.map((id, i) => {
        const p = PLANS[id];
        const on = id === value;
        const usd = Number(period === 'yearly' ? p.priceYearlyUsd : p.priceMonthlyUsd);
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-plan-option={id}
            className={cx('rl-stagger', styles.option)}
            style={staggerStyle(i)}
            onClick={() => onChange(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className={styles.dot} />
            <span className={styles.optText}>
              <span className={styles.optName}>{p.label}</span>
              <span className={styles.optMeta}>
                <FormattedMessage id="account.upgradeModal.plan.meta" values={{ credits: p.monthlyCredits, video: p.maxVideoResolution }} />
              </span>
            </span>
            <span className={styles.optPrice}>
              <FormattedMessage id={period === 'yearly' ? 'account.upgradeModal.price.year' : 'account.upgradeModal.price.month'} values={{ price: money(usd) }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Perks({ plan }: { plan: PlanId }) {
  const p = PLANS[plan];
  const items: Array<[string, Record<string, string | number>]> = [
    ['credits', { n: p.monthlyCredits }],
    ['jobs', { n: p.concurrentJobs }],
    ['video', { res: p.maxVideoResolution }],
    ['image', { res: p.maxImageResolution }],
    ...(p.voiceCloning ? [['voice', {}] as [string, Record<string, string | number>]] : []),
    ...(p.topUpBonus > 0 ? [['topUpBonus', { pct: p.topUpBonus }] as [string, Record<string, string | number>]] : []),
    ['agent', {}],
  ];
  return (
    <div className={styles.perks} data-testid="upgrade-perks">
      <span className={styles.perksKey}>
        <FormattedMessage id="account.upgradeModal.perks" values={{ plan: p.label }} />
      </span>
      <ul className={styles.perkList}>
        {items.map(([id, v]) => (
          <li key={id} className={styles.perk} data-perk={id}>
            <PathIcon d={paths.check} size={14} strokeWidth={2.4} />
            <FormattedMessage id={`account.upgradeModal.perk.${id}`} values={v} />
          </li>
        ))}
      </ul>
    </div>
  );
}
