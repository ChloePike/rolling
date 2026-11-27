/**
 * Trust & safety contracts (D-026 .. D-028): reports, appeals, DMCA notices and
 * counter-notices, reviewer actions, and queue priority. Zod schemas are the
 * request bodies of `/api/trust/*` and `/api/admin/cases/*`.
 */
import { z } from 'zod';

export const REPORT_CATEGORIES = [
  'child_safety',
  'sexual_real_person',
  'non_consensual',
  'violence',
  'extremism',
  'self_harm',
  'harassment',
  'impersonation',
  'illegal',
  'spam',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_TARGETS = ['share', 'profile', 'url'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

/** Queue priority: 2 urgent (child safety), 1 high (other hard limits, flagged workspaces), 0 normal. */
export const PRIORITY = { normal: 0, high: 1, urgent: 2 } as const;

export function reportPriority(category: ReportCategory): number {
  if (category === 'child_safety') return PRIORITY.urgent;
  if (category === 'sexual_real_person' || category === 'non_consensual' || category === 'violence' || category === 'extremism' || category === 'self_harm') return PRIORITY.high;
  return PRIORITY.normal;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalEmail = z.string().trim().toLowerCase().email().max(254).optional();

export const ReportBody = z
  .object({
    targetKind: z.enum(REPORT_TARGETS),
    /** Share id (`shr_…`) or profile handle; for `url`, omitted. */
    targetId: z.string().trim().min(1).max(120).optional(),
    url: z.string().trim().url().max(2000).optional(),
    category: z.enum(REPORT_CATEGORIES),
    details: z.string().trim().max(4000).default(''),
    /** Signed-out reporters may leave an address for follow-up. */
    email: optionalEmail,
  })
  .refine((b) => (b.targetKind === 'url' ? !!b.url : !!b.targetId), { message: 'A target is required.', path: ['targetId'] });
export type ReportInput = z.infer<typeof ReportBody>;

export const AppealBody = z
  .object({
    /** What is appealed: an account or workspace suspension, or a blocked generation. */
    subject: z.enum(['suspension', 'block']),
    suspensionId: z.string().trim().max(80).optional(),
    /** The blocked run or job, when appealing a block. */
    runId: z.string().trim().max(80).optional(),
    jobId: z.string().trim().max(80).optional(),
    message: text(4000),
  });
export type AppealInput = z.infer<typeof AppealBody>;

/**
 * DMCA takedown notice: the elements of 17 U.S.C. § 512(c)(3)(A): signature,
 * the work, the infringing material and where it is, contact details, the
 * good-faith statement, and the accuracy statement under penalty of perjury.
 */
export const DmcaNoticeBody = z.object({
  fullName: text(200),
  /** Rights holder, when the sender acts for someone else. */
  onBehalfOf: z.string().trim().max(200).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: text(60),
  address: text(500),
  workDescription: text(4000),
  /** Links to the material on Rolling (share links, profiles). */
  infringingUrls: z.array(z.string().trim().url().max(2000)).min(1).max(20),
  goodFaith: z.literal(true),
  accuracyUnderPenalty: z.literal(true),
  /** Typed full name as the electronic signature. */
  signature: text(200),
});
export type DmcaNoticeInput = z.infer<typeof DmcaNoticeBody>;

/**
 * Counter-notice (17 U.S.C. § 512(g)(3)): signature, the removed material and
 * where it was, the mistake statement under penalty of perjury, contact
 * details, consent to jurisdiction, and acceptance of service.
 */
export const CounterNoticeBody = z.object({
  /** The DMCA case the removal came from (shown in the removal notice). */
  caseId: z.string().trim().min(1).max(80),
  fullName: text(200),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: text(60),
  address: text(500),
  materialDescription: text(4000),
  mistakeUnderPenalty: z.literal(true),
  consentToJurisdiction: z.literal(true),
  acceptService: z.literal(true),
  signature: text(200),
});
export type CounterNoticeInput = z.infer<typeof CounterNoticeBody>;

/** Business days a counter-notice waits before content may be restored (512(g)(2)(C): 10 to 14). */
export const COUNTER_NOTICE_WAIT_BUSINESS_DAYS = 10;

export function addBusinessDays(ms: number, days: number): number {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.getTime();
}

export const CASE_ACTIONS = ['dismiss', 'warn', 'suspend', 'delete_content', 'escalate_child_safety', 'takedown', 'forward_counter', 'restore', 'uphold', 'overturn', 'mark_submitted', 'close'] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

export const CaseActionBody = z.object({
  action: z.enum(CASE_ACTIONS),
  /** Why (kept in the audit log; never sent to the user verbatim). */
  reason: text(1000),
  /** Text the user sees (warnings, removals); defaults per action. */
  message: z.string().trim().max(1000).optional(),
  /** `suspend`: the user or the whole workspace. */
  scope: z.enum(['user', 'workspace']).optional(),
  /** `mark_submitted`: the CyberTipline report number. */
  reportId: z.string().trim().max(80).optional(),
});
export type CaseActionInput = z.infer<typeof CaseActionBody>;

/** Which actions fit each case kind. */
export const ACTIONS_BY_KIND: Record<string, readonly CaseAction[]> = {
  safety: ['dismiss', 'warn', 'suspend', 'escalate_child_safety', 'close'],
  report: ['dismiss', 'warn', 'suspend', 'delete_content', 'escalate_child_safety', 'close'],
  appeal: ['uphold', 'overturn'],
  dmca: ['dismiss', 'takedown', 'close'],
  counter_notice: ['forward_counter', 'restore', 'dismiss'],
  child_safety: ['suspend', 'delete_content', 'mark_submitted', 'close'],
};

export function actionAllowed(kind: string, action: CaseAction): boolean {
  return (ACTIONS_BY_KIND[kind] ?? []).includes(action);
}

export const DEFAULT_NOTICE: Record<'warn' | 'delete_content' | 'suspend' | 'takedown' | 'restore', string> = {
  warn: 'Some of your recent activity breaks our acceptable use policy. Repeated violations can lead to suspension.',
  delete_content: 'We removed content that breaks our acceptable use policy.',
  suspend: 'Generation and the agent are paused on this account while we review recent activity.',
  takedown: 'We removed content after a copyright notice. You can send a counter-notice if you think this was a mistake.',
  restore: 'We restored content that was removed after a copyright notice.',
};

/** The message a suspended user sees (API `SUSPENDED` and the in-app banner). */
export const SUSPENDED_MESSAGE = 'Generation and the agent are paused on this account. You can still browse and download your work. You can appeal this decision.';
