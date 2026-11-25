/**
 * Hook point for the agent harness (M6): checks user briefs and proposals on
 * mature turns against the D-005 hard limits before the agent plans or a
 * proposal is shown. The harness receives a `SafetyGate` through its ports
 * and never sees codes or details: on `block` it answers with
 * SAFETY_BLOCKED_MESSAGE and ends the turn. The API side logs every block
 * (stage `agent`) through `onVerdict`.
 *
 * Non-mature turns may skip the gate: generation runs are checked again by the
 * pipeline (quote rules, `prepare` pre-check, `store` post-check).
 */
import { preCheck, type SafetyDeps } from './check';
import type { SafetyReference, SafetyVerdict, SafetyModel } from './types';

export interface BriefCheck {
  text: string;
  references?: SafetyReference[];
  mature: boolean;
}

export interface ProposalCheck {
  /** Every prompt and negative prompt a proposal would run (plan shots, patched node params, fields). */
  prompts: { prompt: string; negativePrompt?: string; model?: SafetyModel | null }[];
  references?: SafetyReference[];
  mature: boolean;
}

export interface SafetyGate {
  checkBrief(input: BriefCheck): Promise<SafetyVerdict>;
  /** Blocks when any prompt of the proposal blocks; reasons are merged. */
  checkProposal(input: ProposalCheck): Promise<SafetyVerdict>;
}

export function createSafetyGate(deps: SafetyDeps, onVerdict?: (v: SafetyVerdict, what: 'brief' | 'proposal', excerpt: string) => Promise<void> | void): SafetyGate {
  const report = async (v: SafetyVerdict, what: 'brief' | 'proposal', excerpt: string) => {
    try {
      await onVerdict?.(v, what, excerpt);
    } catch {
      // Logging never changes the verdict.
    }
    return v;
  };
  return {
    async checkBrief(input) {
      const v = await preCheck({ prompt: input.text, references: input.references ?? [], mature: input.mature }, deps);
      return report(v, 'brief', input.text);
    },
    async checkProposal(input) {
      const merged: SafetyVerdict = { verdict: 'allow', reasons: [], checks: [] };
      for (const [i, p] of input.prompts.entries()) {
        const v = await preCheck(
          {
            prompt: p.prompt,
            ...(p.negativePrompt && { negativePrompt: p.negativePrompt }),
            references: i === 0 ? (input.references ?? []) : [],
            mature: input.mature,
            ...(p.model && { model: p.model }),
          },
          deps,
        );
        merged.checks.push(...v.checks);
        for (const r of v.reasons) if (!merged.reasons.some((x) => x.code === r.code)) merged.reasons.push(r);
      }
      if (merged.reasons.length) merged.verdict = 'block';
      return report(merged, 'proposal', input.prompts.map((p) => p.prompt).join(' | '));
    },
  };
}

