import { PLANS } from '@rolling/core/pricing/config';
import { useToast } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { checkoutPlan, useSession } from '@/lib/session';
import { errorCode } from '../api';
import { motion, PathIcon, paths } from '../shared';
import type { BillingPeriod } from '../types';
import { PerSeatNote, SeatStepper, TeamGets, TeamPriceBreakdown } from '../team/TeamPricing';
import styles from './Upgrade.parts.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/**
 * Team on `/upgrade` (D-013): base price with the owner's seat, a seat
 * stepper, the live total for the chosen period and what the seats add.
 * Starts Team (checkout, or the in-place switch from a personal plan); on Team
 * the button leads to Settings → Team to manage seats.
 */
export function TeamPlan({ period, index }: { period: BillingPeriod; index: number }) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const onTeam = session.planId === 'team';
  const [seats, setSeats] = useState(onTeam ? session.seats : 3);
  const [pending, setPending] = useState(false);

  async function start() {
    if (onTeam) return void navigate({ to: '/settings/$section', params: { section: 'team' } });
    if (session.status === 'signedOut') return void navigate({ to: '/signup', search: { redirect: '/upgrade' } });
    setPending(true);
    try {
      // Stripe returns to Settings → Team; a personal plan switches in place.
      await checkoutPlan('team', period, seats, { returnTo: '/settings/team' });
      toast.show({ message: intl.formatMessage({ id: 'account.team.toast.started' }, { n: seats }) });
    } catch (e) {
      const code = errorCode(e);
      toast.show({
        message: intl.formatMessage(
          { id: code === 'SEATS_REQUIRED' ? 'account.team.start.seatsRequired' : code === 'PAYMENT_FAILED' ? 'account.team.toast.failed' : code === 'FORBIDDEN' ? 'account.team.ownerOnly' : 'account.team.toast.failed' },
          { n: seats + 1 },
        ),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="plan-team" className={cx(styles.team, motion.stagger)} style={{ '--i': index } as CSSProperties} data-plan="team">
      <div className={styles.teamInfo}>
        <div className={styles.planHead}>
          <h2 id="plan-team" className={styles.planName}>
            {PLANS.team.label}
          </h2>
          {onTeam && (
            <span className={styles.badgeCurrent}>
              <FormattedMessage id="account.upgrade.current" />
            </span>
          )}
        </div>
        <span className={styles.sectionLead}>
          <FormattedMessage id="account.team.lead" />
        </span>
        <ul className={styles.feats}>
          <li className={styles.feat}>
            <PathIcon d={paths.check} size={15} strokeWidth={2.4} />
            <span>
              <FormattedMessage id="account.team.perks" values={{ pct: PLANS.team.topUpBonus }} />
            </span>
          </li>
          <li className={styles.feat}>
            <PathIcon d={paths.check} size={15} strokeWidth={2.4} />
            <span>
              <FormattedMessage id="account.upgrade.perk.agent" />
            </span>
          </li>
        </ul>
        <TeamGets seats={seats} />
        <PerSeatNote />
      </div>
      <div className={styles.teamCalc} data-testid="team-calculator">
        <SeatStepper value={seats} onChange={setSeats} />
        <TeamPriceBreakdown seats={seats} period={period} />
        <button
          type="button"
          className={cx(styles.cta, styles.ctaPrimary, motion.press)}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void start()}
        >
          {pending ? (
            <FormattedMessage id="account.team.cta.pending" />
          ) : (
            <FormattedMessage id={onTeam ? 'account.team.cta.current' : session.isMember ? 'account.team.cta.switch' : 'account.team.cta.start'} />
          )}
        </button>
      </div>
    </section>
  );
}
