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
import { preCheck, quickCheck, type SafetyDeps } from './check';
import { explicitSignal } from './rules';
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

/**
 * Non-mature turns use the deterministic rules only (free; explicit terms in a
 * proposal → MATURE_REQUIRED). Mature turns add the classifiers: briefs as
 * they are, proposals as one joined text (one classifier call per proposal).
 */
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
      // `input.mature` says the caller may make mature content; the brief is a mature run only when it is explicit.
      // A child in a family scene is not a hit for a mature-allowed caller; a child with sexual content always is.
      const matureRun = input.mature && explicitSignal(input.text).length > 0;
      const pre = { prompt: input.text, references: input.references ?? [], mature: matureRun, matureAllowed: input.mature };
      const v = input.mature ? await preCheck(pre, deps) : stripExplicit(quickCheck(pre));
      return report(v, 'brief', input.text);
    },
    async checkProposal(input) {
      const merged: SafetyVerdict = { verdict: 'allow', reasons: [], checks: [] };
      const add = (v: SafetyVerdict) => {
        merged.checks.push(...v.checks);
        for (const r of v.reasons) if (!merged.reasons.some((x) => x.code === r.code)) merged.reasons.push(r);
      };
      // Rules per prompt (a minor term in one shot and an adult term in another is not a hit).
      // A prompt is a mature run only when it is explicit, never just because the caller may make mature content.
      let explicit = false;
      for (const [i, p] of input.prompts.entries()) {
        const matureRun = input.mature && explicitSignal(p.prompt).length > 0;
        const q = quickCheck({ prompt: p.prompt, references: i === 0 ? (input.references ?? []) : [], mature: matureRun, ...(p.model && { model: p.model }) });
        add(q);
        if (q.explicit.length) explicit = true;
      }
      if (merged.reasons.length === 0) {
        if (!input.mature) {
          if (explicit) merged.reasons.push({ code: 'MATURE_REQUIRED', detail: 'rules: explicit terms in a proposal on a non-mature turn' });
        } else if (input.prompts.length > 0) {
          const joined = input.prompts.map((p, i) => `Prompt ${i + 1}: ${p.prompt}`).join('\n');
          const negative = input.prompts.map((p) => p.negativePrompt).filter(Boolean).join('; ');
          add(await preCheck({ prompt: joined, ...(negative && { negativePrompt: negative }), references: input.references ?? [], mature: explicit, matureAllowed: true }, deps));
        }
      }
      if (merged.reasons.length) merged.verdict = 'block';
      return report(merged, 'proposal', input.prompts.map((p) => p.prompt).join(' | '));
    },
  };
}

function stripExplicit(v: SafetyVerdict & { explicit?: string[] }): SafetyVerdict {
  const { explicit: _explicit, ...rest } = v;
  return rest;
}
