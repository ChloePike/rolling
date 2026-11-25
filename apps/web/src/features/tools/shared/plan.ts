import { lowestPlanFor, planAllowsResolution, type PlanId } from '@rolling/core/pricing/config';
import type { IntlShape } from 'react-intl';
import type { SegOption } from './SettingsGroup';

/** Current plan until the account API lands (mock, D-006). */
export const mockPlan: PlanId = 'starter';

/**
 * Resolution options for a plan (D-006): options above the plan's cap stay
 * visible but locked, labeled with the lowest plan that unlocks them.
 */
export function resolutionOptions(intl: IntlShape, plan: PlanId, kind: 'video' | 'image', list: string[]): SegOption[] {
  return list.map((res) => {
    if (planAllowsResolution(plan, kind, res)) return { value: res, label: res };
    const unlock = lowestPlanFor(kind, res);
    const planName = unlock ? intl.formatMessage({ id: `tools.plan.${unlock}` }) : '';
    return {
      value: res,
      label: res,
      disabled: true,
      lockedBy: planName,
      reason: intl.formatMessage({ id: 'tools.adv.lockedBy' }, { plan: planName }),
    };
  });
}

/** Locked resolutions, for the shared settings popover's `unsupported` list. */
export function lockedResolutions(plan: PlanId, kind: 'video' | 'image', list: string[]): string[] {
  return list.filter((res) => !planAllowsResolution(plan, kind, res));
}

/**
 * Membership mock (D-007): generating and the agent path (Refine, Simple-mode
 * field filling) need an active plan. Defaults to a member so the design states
 * render as drawn; set localStorage `rolling.mock.isMember` to `false` to try
 * the non-member path. Replaced by the account API.
 */
export const MOCK_MEMBER_KEY = 'rolling.mock.isMember';
export function mockIsMember(): boolean {
  try {
    return window.localStorage.getItem(MOCK_MEMBER_KEY) !== 'false';
  } catch {
    return true;
  }
}
