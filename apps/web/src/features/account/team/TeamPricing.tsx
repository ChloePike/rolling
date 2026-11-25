import {
  PLANS,
  SEAT_PRICE,
  TEAM_SEATS,
  teamAgentAllowanceUsd,
  teamConcurrentJobs,
  teamIncludedCredits,
  teamPriceCents,
} from '@rolling/core/pricing/config';
import { useId } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUsd } from '@/lib/topUp';
import { PathIcon, paths, Swap } from '../shared';
import type { BillingPeriod } from '../types';
import styles from './team.module.css';

export const teamInterval = (p: BillingPeriod) => (p === 'yearly' ? 'year' : 'month') as 'month' | 'year';

/** Formats USD with the current locale (two decimals only when needed). */
export function useMoney() {
  const intl = useIntl();
  return (usd: number) => formatUsd(usd, (v, o) => intl.formatNumber(v, o));
}

/** Seat price for a period, in USD. */
export const seatUsd = (period: BillingPeriod) => (period === 'yearly' ? SEAT_PRICE.priceYearlyUsd : SEAT_PRICE.priceMonthlyUsd);
export const baseUsd = (period: BillingPeriod) => Number(period === 'yearly' ? PLANS.team.priceYearlyUsd : PLANS.team.priceMonthlyUsd);

/**
 * Seat count control: − / number / +. Keyboard: arrows step in the field, Enter
 * keeps the value; the field clamps to [min, max] on blur.
 */
export function SeatStepper({ value, min = TEAM_SEATS.min, max = TEAM_SEATS.max, onChange, hint }: { value: number; min?: number; max?: number; onChange: (n: number) => void; hint?: React.ReactNode }) {
  const intl = useIntl();
  const id = useId();
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
  return (
    <div className={styles.seatsRow}>
      <span className={styles.seatsText}>
        <label htmlFor={id} className={styles.seatsLabel}>
          <FormattedMessage id="account.team.seats" />
        </label>
        <span className={styles.seatsHint}>{hint ?? <FormattedMessage id="account.team.seats.hint" />}</span>
      </span>
      <span className={styles.stepper} data-testid="seat-stepper">
        <button type="button" className={styles.stepBtn} aria-label={intl.formatMessage({ id: 'account.team.seats.fewer' })} disabled={value <= min} onClick={() => onChange(clamp(value - 1))}>
          <PathIcon d={paths.minus} size={15} />
        </button>
        <input
          id={id}
          className={styles.stepInput}
          inputMode="numeric"
          role="spinbutton"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ''));
            if (e.target.value === '') return;
            onChange(Math.min(max, Math.max(0, n)) || min);
          }}
          onBlur={() => onChange(clamp(value))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onChange(clamp(value + 1));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onChange(clamp(value - 1));
            }
          }}
        />
        <button type="button" className={styles.stepBtn} aria-label={intl.formatMessage({ id: 'account.team.seats.more' })} disabled={value >= max} onClick={() => onChange(clamp(value + 1))}>
          <PathIcon d={paths.plus} size={15} />
        </button>
      </span>
    </div>
  );
}

/** Base + extra seats = total, for the chosen period (values swap with motion). */
export function TeamPriceBreakdown({ seats, period }: { seats: number; period: BillingPeriod }) {
  const money = useMoney();
  const interval = teamInterval(period);
  const total = teamPriceCents(seats, interval) / 100;
  const extra = seats - 1;
  return (
    <dl className={styles.breakdown} data-testid="team-breakdown">
      <div className={styles.line}>
        <dt>
          <FormattedMessage id="account.team.base" />
        </dt>
        <dd>{money(baseUsd(period))}</dd>
      </div>
      <div className={styles.line}>
        <dt>
          <FormattedMessage id="account.team.extra" values={{ n: extra, price: money(seatUsd(period)) }} />
        </dt>
        <dd>
          <Swap id={`x${extra}-${period}`}>{money(extra * seatUsd(period))}</Swap>
        </dd>
      </div>
      <div className={styles.total}>
        <dt>
          <FormattedMessage id={`account.team.total.${interval}`} />
        </dt>
        <dd data-testid="team-total">
          <Swap id={`${total}-${period}`}>
            <FormattedMessage id={`account.team.totalValue.${interval}`} values={{ price: money(total) }} />
          </Swap>
          {period === 'yearly' && (
            <span className={styles.totalSub}>
              <FormattedMessage id="account.team.perMonthEquivalent" values={{ price: money(Math.round((total / 12) * 100) / 100) }} />
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** Shared credits, jobs at once and agent allowance for a seat count. */
export function TeamGets({ seats }: { seats: number }) {
  const money = useMoney();
  const items = [
    { id: 'credits', node: <FormattedMessage id="account.team.gets.credits" values={{ n: teamIncludedCredits(seats) }} /> },
    { id: 'jobs', node: <FormattedMessage id="account.team.gets.jobs" values={{ n: teamConcurrentJobs(seats) }} /> },
    { id: 'agent', node: <FormattedMessage id="account.team.gets.agent" values={{ amount: money(teamAgentAllowanceUsd(seats)) }} /> },
  ];
  return (
    <div>
      <span className={styles.getsKey}>
        <FormattedMessage id="account.team.gets" />
      </span>
      <ul className={styles.gets} data-testid="team-gets">
        {items.map((it) => (
          <li key={it.id} className={styles.getsItem} data-get={it.id}>
            <PathIcon d={paths.check} size={14} strokeWidth={2.4} />
            <Swap id={`${it.id}-${seats}`}>{it.node}</Swap>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One line: what each extra seat adds. */
export function PerSeatNote() {
  const money = useMoney();
  return (
    <p className={styles.note}>
      <FormattedMessage
        id="account.team.perSeat"
        values={{ credits: SEAT_PRICE.monthlyCredits, jobs: SEAT_PRICE.concurrentJobs, max: SEAT_PRICE.maxConcurrentJobs, agent: money(SEAT_PRICE.agentAllowanceUsd) }}
      />
    </p>
  );
}
