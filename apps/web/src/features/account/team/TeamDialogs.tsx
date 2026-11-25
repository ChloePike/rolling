import { prorate, SEAT_PRICE, TEAM_SEATS, teamPriceCents } from '@rolling/core/pricing/config';
import { Dialog, useToast } from '@rolling/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { changeSeats, checkoutPlan, mockPeriod, MockFlowError, useSession } from '@/lib/session';
import { meKey } from '../api';
import { motion, Segmented } from '../shared';
import type { BillingPeriod } from '../types';
import settings from '../Settings.module.css';
import { PerSeatNote, SeatStepper, seatUsd, TeamGets, TeamPriceBreakdown, teamInterval, useMoney } from './TeamPricing';
import styles from './team.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/**
 * "Start Team to invite people" (D-013): the invite button on a personal plan
 * opens this. Seats start at the people already in the workspace plus the one
 * being invited; Continue runs the Team checkout (or the in-place switch) and
 * `onStarted` resumes the invite flow.
 */
export function StartTeamDialog({ open, onClose, used, onStarted }: { open: boolean; onClose: () => void; used: number; onStarted: (seats: number) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const qc = useQueryClient();
  const session = useSession();
  const min = Math.max(TEAM_SEATS.min, used);
  const [seats, setSeats] = useState(Math.max(2, used + 1));
  const [period, setPeriod] = useState<BillingPeriod>(session.plan?.period ?? 'monthly');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      await checkoutPlan('team', period, seats);
      await qc.invalidateQueries({ queryKey: meKey });
      toast.show({ message: intl.formatMessage({ id: 'account.team.toast.started' }, { n: seats }) });
      onStarted(seats);
    } catch (e) {
      void e;
      setError(intl.formatMessage({ id: 'account.team.toast.failed' }));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !pending && onClose()}
      title={intl.formatMessage({ id: 'account.team.start.title' })}
      description={intl.formatMessage({ id: 'account.team.start.lead' })}
      closeLabel={intl.formatMessage({ id: 'account.settings.close' })}
      width={460}
    >
      <div className={styles.dlgBody} data-testid="start-team">
        <Segmented<BillingPeriod>
          label={intl.formatMessage({ id: 'account.upgrade.period' })}
          value={period}
          onChange={setPeriod}
          className={settings.seg}
          optionClassName={settings.segOption}
          indicatorClassName={settings.segFill}
          options={[
            { value: 'monthly', label: intl.formatMessage({ id: 'account.upgrade.period.monthly' }) },
            { value: 'yearly', label: intl.formatMessage({ id: 'account.upgrade.period.yearly' }) },
          ]}
        />
        <SeatStepper value={seats} min={min} onChange={setSeats} hint={used > 1 ? <FormattedMessage id="account.team.start.inUse" values={{ n: used }} /> : undefined} />
        <TeamPriceBreakdown seats={seats} period={period} />
        <TeamGets seats={seats} />
        <p className={styles.note}>
          <FormattedMessage id="account.team.start.note" />
        </p>
        {error && (
          <p role="alert" className={cx(settings.fieldError, motion.enter)}>
            {error}
          </p>
        )}
        <div className={settings.dlgActions}>
          <button type="button" className={cx(settings.btn, motion.hover)} onClick={onClose} disabled={pending}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button type="button" className={cx(settings.btn, settings.btnPrimary, motion.press)} disabled={pending} aria-busy={pending || undefined} onClick={() => void start()}>
            <FormattedMessage id={pending ? 'account.team.cta.pending' : 'account.team.start.continue'} />
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Add or lower Team seats (`PATCH /api/billing/seats`). Increases show the
 * prorated amount due today and the credits added now; decreases apply now
 * without a refund and cannot go below the seats in use.
 */
export function SeatsDialog({
  open,
  onClose,
  used,
  initial,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  used: number;
  /** Seats to start from (e.g. the count an invite needs). */
  initial?: number;
  onDone?: (seats: number) => void;
}) {
  const intl = useIntl();
  const toast = useToast();
  const qc = useQueryClient();
  const money = useMoney();
  const session = useSession();
  const current = session.seats;
  const period: BillingPeriod = session.plan?.period ?? 'monthly';
  const [seats, setSeats] = useState(initial ?? current + 1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = Math.max(TEAM_SEATS.min, used);
  const added = Math.max(0, seats - current);
  const p = mockPeriod();
  const now = Date.now();
  const dueToday = prorate(Math.round(added * seatUsd(period) * 100), p.start, p.end, now) / 100;
  const creditsNow = prorate(added * SEAT_PRICE.monthlyCredits, p.start, p.end, now);
  const next = teamPriceCents(seats, teamInterval(period)) / 100;
  const lowering = seats < current;

  async function save() {
    setPending(true);
    setError(null);
    try {
      const r = await changeSeats(seats, used);
      await qc.invalidateQueries({ queryKey: meKey });
      toast.show({
        message: intl.formatMessage({ id: r.seats < r.previous ? 'account.team.add.toastLower' : 'account.team.add.toast' }, { n: r.seats, credits: r.granted }),
      });
      onDone?.(r.seats);
      onClose();
    } catch (e) {
      const code = e instanceof MockFlowError ? e.code : null;
      setError(
        code === 'SEATS_IN_USE'
          ? intl.formatMessage({ id: 'account.team.add.min' }, { n: used })
          : intl.formatMessage({ id: 'account.team.toast.failed' }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !pending && onClose()}
      title={intl.formatMessage({ id: initial !== undefined ? 'account.team.add.title' : 'account.team.change.title' })}
      description={intl.formatMessage({ id: 'account.team.add.lead' })}
      closeLabel={intl.formatMessage({ id: 'account.settings.close' })}
      width={460}
    >
      <div className={styles.dlgBody} data-testid="seats-dialog">
        <SeatStepper value={seats} min={min} onChange={setSeats} hint={<FormattedMessage id="account.team.add.min" values={{ n: used }} />} />
        <dl className={styles.breakdown}>
          <div className={styles.line}>
            <dt>
              <FormattedMessage id="account.team.add.dueToday" />
            </dt>
            <dd data-testid="seats-due">{money(dueToday)}</dd>
          </div>
          <div className={styles.line}>
            <dt>
              <FormattedMessage id="account.team.add.credits" />
            </dt>
            <dd data-testid="seats-credits">{intl.formatNumber(creditsNow)}</dd>
          </div>
          <div className={styles.total}>
            <dt>
              <FormattedMessage id="account.team.add.next" />
            </dt>
            <dd data-testid="seats-next">
              <FormattedMessage id={`account.team.totalValue.${teamInterval(period)}`} values={{ price: money(next) }} />
            </dd>
          </div>
        </dl>
        <TeamGets seats={seats} />
        {lowering ? (
          <p className={cx(styles.warn, motion.enter)}>
            <FormattedMessage id="account.team.add.lower" />
          </p>
        ) : (
          <PerSeatNote />
        )}
        {error && (
          <p role="alert" className={cx(settings.fieldError, motion.enter)}>
            {error}
          </p>
        )}
        <div className={settings.dlgActions}>
          <button type="button" className={cx(settings.btn, motion.hover)} onClick={onClose} disabled={pending}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button
            type="button"
            className={cx(settings.btn, settings.btnPrimary, motion.press)}
            disabled={pending || seats === current}
            aria-busy={pending || undefined}
            onClick={() => void save()}
          >
            {pending ? (
              <FormattedMessage id="account.team.add.saving" />
            ) : lowering ? (
              <FormattedMessage id="account.team.add.lowerConfirm" values={{ n: seats }} />
            ) : (
              <FormattedMessage id="account.team.add.confirm" values={{ n: Math.max(1, added) }} />
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
