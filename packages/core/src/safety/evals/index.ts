/**
 * D-005 false-positive eval: the case set (false-positives.json) and the
 * helpers both levels share. The rules level runs offline in Vitest
 * (rules.fp.test.ts); the classifier level runs live from
 * packages/agent/evals/safety-fp-live.ts.
 */
import data from './false-positives.json';
import type { ChatEvent, LlmProvider } from '../../models/types';
import { createSafetyGate, type SafetyGate } from '../gate';
import type { ChatCatalog } from '../llm';
import { HARD_LIMIT_CODES, type SafetyVerdict } from '../types';

export type FpOutcome = 'allow' | 'mature_required' | 'block' | 'error';
export type CallerKind = 'nonMature' | 'matureAllowed';
export const CALLER_KINDS: readonly CallerKind[] = ['nonMature', 'matureAllowed'];

export interface FpCase {
  id: string;
  lang: 'en' | 'zh-CN' | 'ja' | 'ko';
  /** `brief`: a user brief (agent gate checkBrief); `shot`: a shot prompt (agent gate checkProposal, pipeline pre-check). */
  kind: 'brief' | 'shot';
  category: string;
  text: string;
  expect: Record<CallerKind, Exclude<FpOutcome, 'error'>>;
  /** True positives only: the hard limit it must hit. */
  code?: string;
  /** True positives only: the cheapest check expected to block it. */
  layer?: 'rules' | 'classifier';
}

export const FP_CASES: readonly FpCase[] = data.cases as FpCase[];
export const isTruePositive = (c: FpCase) => c.code !== undefined;

/** A verdict as an eval outcome: any hard limit (or identity rule) blocks; MATURE_REQUIRED alone asks for mature content. */
export function outcomeOf(v: SafetyVerdict): FpOutcome {
  const codes = v.reasons.map((r) => r.code);
  if (codes.some((c) => HARD_LIMIT_CODES.has(c) || c === 'IDENTITY_SWAP_MATURE')) return 'block';
  if (codes.includes('SAFETY_UNAVAILABLE')) return 'error';
  if (codes.includes('MATURE_REQUIRED')) return 'mature_required';
  return v.verdict === 'block' ? 'block' : 'allow';
}

/** Text classifier stand-in that finds nothing: only the deterministic rules decide. */
export const nothingFoundLlm: LlmProvider = {
  id: 'nothing-found',
  async *chat(): AsyncIterable<ChatEvent> {
    yield {
      type: 'text',
      delta: JSON.stringify({ sexualLevel: 'none', apparentMinor: false, minorSexualized: false, realPerson: false, realPersonNames: [], realPersonSexualOrIntimate: false, nonConsensualSexual: false, animalSexual: false, extremeViolence: false, violentExtremism: false, selfHarm: false }),
    };
  },
};

export function rulesLevelGate(chatModels: ChatCatalog): SafetyGate {
  let n = 0;
  return createSafetyGate({ llm: nothingFoundLlm, chatModels, newKey: () => `fp_eval_${++n}` });
}

/**
 * One case through the agent gate as the given caller: briefs through
 * `checkBrief`, shot prompts through `checkProposal` (one-shot plan).
 */
export async function runThroughGate(gate: SafetyGate, c: FpCase, caller: CallerKind): Promise<FpOutcome> {
  const mature = caller === 'matureAllowed';
  const v = c.kind === 'brief' ? await gate.checkBrief({ text: c.text, mature }) : await gate.checkProposal({ prompts: [{ prompt: c.text }], mature });
  return outcomeOf(v);
}

/**
 * The outcome the gate should give at the rules level. Non-mature briefs are
 * rules-only and never ask for mature content (the pipeline does), so an
 * expected `mature_required` reads as `allow` there. Classifier-layer true
 * positives are not expected to block without the classifier (null = not asserted).
 */
export function rulesLevelExpectation(c: FpCase, caller: CallerKind): FpOutcome | null {
  if (isTruePositive(c) && c.layer !== 'rules') return null;
  const e = c.expect[caller];
  if (e === 'mature_required' && c.kind === 'brief' && caller === 'nonMature') return 'allow';
  return e;
}
