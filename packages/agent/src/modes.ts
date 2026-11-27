/**
 * Agent modes (D-021): Read, Edit (the default) and Auto.
 *
 * - Read: read tools only. No propose or run tool is offered, and the loop refuses
 *   one the model calls anyway, so a Read turn cannot change anything.
 * - Edit: the agent proposes; the user previews and applies (docs/harness.md section 2).
 * - Auto: graph and timeline patches (and a plan's first option) are applied through
 *   ProjectRoom as soon as they validate, within `AUTO_LIMITS`; `run.start` starts runs
 *   within the turn's credit budget (quote → hold → settle in CreditAccount). A run over
 *   the remaining budget is not started: it is surfaced for approval as in Edit.
 */
import { AGENT_MODES, type AgentMode } from '@rolling/core/auth/prefs';

export { AGENT_MODES, type AgentMode };
export const DEFAULT_AGENT_MODE: AgentMode = 'edit';

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v);
}

/**
 * Auto mode limits per turn. Beyond them a proposal is kept for the user to apply,
 * as in Edit, and a run is not started.
 */
export const AUTO_LIMITS = {
  /** Proposals applied automatically in one turn. */
  maxAppliedPerTurn: 3,
  /** Graph and timeline ops applied automatically in one turn (a 60 s plan builds about 40). */
  maxOpsPerTurn: 60,
  /** `run.start` calls that may start a run in one turn. */
  maxRunsPerTurn: 4,
} as const;

/** What happens to a run the agent asks for in Auto. */
export type RunDecision =
  | { action: 'start' }
  /** Over the turn's remaining budget: shown to the user as "Run · N credits". */
  | { action: 'approve'; reason: 'over_budget' }
  | { action: 'refuse'; code: 'INSUFFICIENT_CREDITS' | 'MEMBER_LIMIT_REACHED' | 'NOTHING_TO_RUN' };

/**
 * The credit budget of one Auto turn. `spent` counts the quoted credits of the runs
 * started in this turn (the holds themselves stay in CreditAccount; refunds of failed
 * jobs do not give budget back within the turn).
 */
export class TurnBudget {
  private used = 0;

  constructor(readonly total: number) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  /**
   * `credits`: the quote's total; `available`: the workspace balance the quote saw;
   * `memberLeft`: what the member's monthly limit still allows (D-013), when known.
   */
  decide(q: { credits: number; available: number; memberLeft?: number | null }): RunDecision {
    if (!(q.credits > 0)) return { action: 'refuse', code: 'NOTHING_TO_RUN' };
    if (q.credits > q.available) return { action: 'refuse', code: 'INSUFFICIENT_CREDITS' };
    if (typeof q.memberLeft === 'number' && q.credits > q.memberLeft) return { action: 'refuse', code: 'MEMBER_LIMIT_REACHED' };
    if (q.credits > this.remaining) return { action: 'approve', reason: 'over_budget' };
    return { action: 'start' };
  }

  commit(credits: number): void {
    this.used += Math.max(0, credits);
  }
}

/** The mode as a section of the system context (the agent knows what its tools do this turn). */
export function modeSection(mode: AgentMode, budget?: { total: number; remaining: number }): string {
  if (mode === 'read') {
    return [
      '# Mode: Read',
      'This turn is read only. You have no propose or run tools and nothing on the canvas, the timeline or the forms changes.',
      'Answer, analyse, explain and estimate with the read tools. When the user asks for a change, say in one sentence what you would change and that they can switch to Edit or Auto to make it.',
    ].join('\n');
  }
  if (mode === 'edit') {
    return ['# Mode: Edit', 'You propose; the user previews the proposal and applies or discards it.'].join('\n');
  }
  const left = budget ? `${budget.remaining} of ${budget.total} credits are left in this turn's run budget.` : '';
  return [
    '# Mode: Auto',
    'This section replaces "never apply" and "never run" in Role and Reply for this turn.',
    `- Graph and timeline patches are applied as soon as they pass the server checks (a plan builds its first option on the canvas). The user can undo each change. At most ${AUTO_LIMITS.maxAppliedPerTurn} changes and ${AUTO_LIMITS.maxOpsPerTurn} ops per turn; beyond that the proposal waits for the user.`,
    '- A propose result with `applied: true` is on the canvas: you may then say what changed. Never say a run finished or that anything was generated.',
    `- \`run.start\` with node ids starts those runs (their inputs are included). Use it only when the user asked for results, not just for edits. ${left} The server quotes the run; a run over the budget is not started and the user is asked to approve it. At most ${AUTO_LIMITS.maxRunsPerTurn} run.start calls per turn.`,
    '- Do not write credit numbers; the panel shows the spend against the budget.',
  ]
    .filter(Boolean)
    .join('\n');
}
