import { lowestPlanFor, PERSONAL_PLAN_ORDER, PLAN_ORDER, PLANS, resolutionRank, type PlanId } from '@rolling/core/pricing/config';

/**
 * Why the upgrade modal opened (owner request: every locked click opens one
 * modal in place). The reason picks the headline ("1080p needs Plus"), the
 * plan preselected (the lowest plan that unlocks it, from the pricing config)
 * and the variant (personal plans, Team with seats, or a top-up for members).
 */
export type UpgradeReason =
  /** A resolution above the plan's cap (D-006). `media` defaults from the label (`2K`/`4K` → image only when given). */
  | { kind: 'resolution'; value: string; media?: 'video' | 'image' }
  /** A model whose lowest resolution is above the plan's cap, or an explicit `plan`. */
  | { kind: 'model'; id: string; name?: string; plan?: PlanId; resolutions?: readonly string[]; media?: 'video' | 'image' }
  /** Outputs at once above the plan's concurrent jobs. */
  | { kind: 'count'; value: number }
  /** A length the plan does not include (`plan` names the plan that does). */
  | { kind: 'duration'; value: number; plan?: PlanId }
  /** Using the agent without a plan (D-007). */
  | { kind: 'agent' }
  /** Generating without a plan (D-007). */
  | { kind: 'generate' }
  /** The mature-content preference without a plan (D-005). */
  | { kind: 'mature' }
  | { kind: 'voice-clone' }
  /** Inviting people needs Team (D-013). `seats` preselects the seat count, `minSeats` is the people already in. */
  | { kind: 'team-invite'; seats?: number; minSeats?: number }
  /** Buying credits: a plan first for non-members; members get the top-up (`needed`/`balance` from `INSUFFICIENT_CREDITS`). */
  | { kind: 'top-up'; needed?: number; balance?: number }
  | { kind: 'auto-top-up' }
  /** A plain "Upgrade" / "Pick a plan" CTA. */
  | { kind: 'plan'; plan?: PlanId }
  /** D-022: the trial's credits are used up (the brief stays). */
  | { kind: 'trial-used' }
  /** D-022: the trial ended. */
  | { kind: 'trial-expired' }
  /** D-022: other agent models, or the trial's agent allowance is used up. */
  | { kind: 'trial-agent' }
  /** D-022: exports above 720p need a plan. */
  | { kind: 'export'; value?: string };

export type UpgradeReasonKind = UpgradeReason['kind'];

/** Plan order rank; Team carries Pro's perks (D-013) so it ranks above Pro. */
export function planRank(plan: PlanId | null | undefined): number {
  return plan ? PLAN_ORDER.indexOf(plan) : -1;
}

/** Video unless the label only exists for images (`1K`, `2K`). `4K` reads as video, which has the same cap. */
export function mediaOf(value: string): 'video' | 'image' {
  return /^[12]K$/i.test(value) ? 'image' : 'video';
}

/** The lowest plan whose cap covers the model's smallest resolution (models run at least at that size). */
export function lowestPlanForModel(m: { media?: 'video' | 'image'; resolutions?: readonly string[] | null }): PlanId {
  const list = (m.resolutions ?? []).filter(Boolean);
  if (!list.length) return PLAN_ORDER[0]!;
  const min = [...list].sort((a, b) => resolutionRank(a) - resolutionRank(b))[0]!;
  return lowestPlanFor(m.media ?? mediaOf(min), min) ?? 'pro';
}

/** The lowest plan that unlocks what the reason asks for. */
export function requiredPlan(reason: UpgradeReason): PlanId {
  switch (reason.kind) {
    case 'resolution':
      return lowestPlanFor(reason.media ?? mediaOf(reason.value), reason.value) ?? 'pro';
    case 'model':
      return reason.plan ?? lowestPlanForModel(reason);
    case 'count':
      return PERSONAL_PLAN_ORDER.find((p) => PLANS[p].concurrentJobs >= reason.value) ?? 'pro';
    case 'duration':
      return reason.plan ?? 'plus';
    case 'voice-clone':
      return PERSONAL_PLAN_ORDER.find((p) => PLANS[p].voiceCloning) ?? 'pro';
    case 'team-invite':
      return 'team';
    case 'plan':
      return reason.plan ?? PLAN_ORDER[0]!;
    default:
      // Membership itself (agent, generating, mature content, top-ups): every plan.
      return PLAN_ORDER[0]!;
  }
}

/** True when `plan` already covers the reason (the modal then shows "You're on …"). */
export function isUnlockedBy(reason: UpgradeReason, plan: PlanId | null | undefined): boolean {
  if (!plan) return false;
  if (reason.kind === 'team-invite') return plan === 'team';
  return planRank(plan) >= planRank(requiredPlan(reason));
}

/** Which variant the modal shows. A member asking for credits gets the top-up; Team asks for seats. */
export function upgradeVariant(reason: UpgradeReason, current: PlanId | null | undefined): 'personal' | 'team' | 'topUp' {
  if (reason.kind === 'team-invite') return 'team';
  if ((reason.kind === 'top-up' || reason.kind === 'auto-top-up') && current) return 'topUp';
  return offeredPlans(reason, current).length ? 'personal' : 'team';
}

/**
 * Personal plans the modal offers: those that unlock the reason and are above
 * the current plan. Empty when no personal plan helps (a Pro member: Team).
 */
export function offeredPlans(reason: UpgradeReason, current: PlanId | null | undefined): PlanId[] {
  if (reason.kind === 'team-invite') return [];
  const need = planRank(requiredPlan(reason));
  const have = planRank(current);
  return PERSONAL_PLAN_ORDER.filter((p) => planRank(p) >= need && planRank(p) > have);
}

/** The plan selected when the modal opens: the lowest offered one (Team when none). */
export function preselectedPlan(reason: UpgradeReason, current: PlanId | null | undefined): PlanId {
  return offeredPlans(reason, current)[0] ?? 'team';
}

/** Seats the Team variant starts at: the reason's, else everyone already in plus one being invited (min 2). */
export function teamSeatsFor(reason: UpgradeReason): { seats: number; min: number } {
  const min = reason.kind === 'team-invite' ? Math.max(1, reason.minSeats ?? 1) : 1;
  const seats = reason.kind === 'team-invite' ? (reason.seats ?? Math.max(2, min + 1)) : 3;
  return { seats: Math.max(min, seats), min };
}
