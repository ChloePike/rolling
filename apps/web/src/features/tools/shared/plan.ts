import { PLAN_ORDER, type PlanId } from '@rolling/core/pricing/config';
import { planLockInfo } from '@/features/overlays';
import type { IntlShape } from 'react-intl';
import { useSession } from '@/lib/session';
import type { SegOption } from './SettingsGroup';

/**
 * Plan whose caps the tool shows (D-006): an explicit prop, else the session's
 * plan, else the entry plan (non-members see what joining unlocks).
 */
export function useToolPlan(planProp?: PlanId): PlanId {
  const { planId } = useSession();
  return planProp ?? planId ?? PLAN_ORDER[0]!;
}

/**
 * Resolution options for a plan (D-006): options above the plan's cap stay
 * visible but locked, labeled with the lowest plan that unlocks them.
 */
export function resolutionOptions(intl: IntlShape, plan: PlanId, kind: 'video' | 'image', list: string[]): SegOption[] {
  return list.map((res) => {
    const lock = planLockInfo(intl, plan, kind, res);
    return lock ? { value: res, label: res, disabled: true, lockedBy: lock.plan, reason: lock.reason } : { value: res, label: res };
  });
}
