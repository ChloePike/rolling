import { lowestPlanFor, planAllowsResolution, PLANS, type PlanId } from '@rolling/core/pricing/config';
import { cx } from '@rolling/ui';
import type { IntlShape } from 'react-intl';
import { Svg } from './icons';
import styles from './PlanLock.module.css';

/**
 * Lock chip for an option the current plan does not include (D-006): a lock
 * icon and the name of the lowest plan that unlocks it. Decorative; the host
 * puts the same information in the option's accessible name and tooltip
 * (`planLockInfo`).
 */
export function PlanLock({ plan, className }: { plan: PlanId; className?: string }) {
  return (
    <span className={cx(styles.lock, className)} aria-hidden="true" data-plan-lock={plan}>
      <Svg name="lock" size={10} strokeWidth={2.4} />
      {PLANS[plan].label}
    </span>
  );
}

export interface PlanLockInfo {
  /** Lowest plan that unlocks the option. */
  plan: PlanId;
  /** "Available on Pro" (tooltip). */
  reason: string;
  /** "4K, Available on Pro" (accessible name). */
  label: string;
}

/**
 * Lock details for one resolution, or null when `plan` includes it. Unknown
 * labels (no plan unlocks them) are not locked here; the server refuses them.
 */
export function planLockInfo(intl: IntlShape, plan: PlanId, kind: 'video' | 'image', resolution: string): PlanLockInfo | null {
  if (planAllowsResolution(plan, kind, resolution)) return null;
  const unlock = lowestPlanFor(kind, resolution);
  if (!unlock) return null;
  const reason = intl.formatMessage({ id: 'overlays.planLock.reason' }, { plan: PLANS[unlock].label });
  return { plan: unlock, reason, label: intl.formatMessage({ id: 'overlays.planLock.label' }, { option: resolution, reason }) };
}
