/**
 * D-005 false-positive eval, classifier level (live): every case of
 * @rolling/core safety/evals/false-positives.json through the real text
 * classifier (same model resolution, prompt and decision rules as
 * production), for a non-mature caller and a mature-allowed caller.
 *
 *   HYPEROUTER_API_KEY=... pnpm --filter @rolling/agent eval:safety-fp [--budget 1] [--concurrency 6] [--only b-zh,t-] [--out file.json]
 *
 * The key may also be in HYPEROUTER_KEY. `--budget` (USD, default 1) stops
 * starting new calls once the reported gateway cost reaches it.
 *
 * Per case and caller it reports two outcomes:
 * - classifier: the text classifier's own verdict (textReasons), even where
 *   the rules would have blocked first;
 * - pipeline: rules, then the classifier (what preCheck decides).
 * The caller kinds follow the agent gate: a mature-allowed caller's text is a
 * mature run only when it is explicit; MATURE_REQUIRED for a mature-allowed
 * caller is a re-plan, not a block.
 *
 * Writes evals/results/safety-fp-<timestamp>.json (or --out) and prints false
 * positives, misses and spend. Exit code 1 when any true positive is missed or
 * any benign case blocks with a hard limit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { hyperouter } from '@rolling/core';
import { fixtureCatalog } from '@rolling/core/models/__fixtures__/catalog';
import { classifyText, explicitSignal, quickCheck, SAFETY_PROMPT_VERSION, textModelFor, textReasons, type SafetyReason } from '@rolling/core/safety';
import { CALLER_KINDS, FP_CASES, isTruePositive, outcomeOf, type CallerKind, type FpCase, type FpOutcome } from '@rolling/core/safety/evals/index';

const { HyperouterLlmProvider } = hyperouter;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const apiKey = process.env.HYPEROUTER_API_KEY || process.env.HYPEROUTER_KEY;
if (!apiKey) {
  console.error('HYPEROUTER_API_KEY is not set');
  process.exit(2);
}
const budget = Number(flag('budget') ?? 1);
const concurrency = Number(flag('concurrency') ?? 6);
const only = flag('only')?.split(',');
const cases = FP_CASES.filter((c) => !only || only.some((o) => c.id.startsWith(o)));
const llm = new HyperouterLlmProvider({ apiKey, ...(process.env.HYPEROUTER_BASE_URL ? { baseUrl: process.env.HYPEROUTER_BASE_URL.replace(/\/v1$/, '') } : {}) });
const model = textModelFor(fixtureCatalog.list({ kind: 'chat', includeMatureOnly: true }));

interface Row {
  id: string;
  caller: CallerKind;
  truePositive: boolean;
  expected: string;
  mature: boolean;
  classifier: FpOutcome;
  pipeline: FpOutcome;
  codes: string[];
  assessment?: unknown;
  error?: string;
  costUsd?: number;
  ms?: number;
}

/** MATURE_REQUIRED of a mature-allowed caller is a re-plan as a mature run, not a block (preCheck: needsMature). */
function callerOutcome(reasons: SafetyReason[], caller: CallerKind): FpOutcome {
  const r = caller === 'matureAllowed' ? reasons.filter((x) => x.code !== 'MATURE_REQUIRED') : reasons;
  return outcomeOf({ verdict: r.length ? 'block' : 'allow', reasons: r, checks: [] });
}

let spent = 0;
let keyN = 0;
const runId = Date.now();

async function runOne(c: FpCase, caller: CallerKind): Promise<Row> {
  const mature = caller === 'matureAllowed' && explicitSignal(c.text).length > 0;
  const rules = quickCheck({ prompt: c.text, references: [], mature, matureAllowed: caller === 'matureAllowed' });
  const base = { id: c.id, caller, truePositive: isTruePositive(c), expected: c.expect[caller], mature };
  try {
    const res = await classifyText(llm, model, { prompt: c.text, captions: [], mature }, `fp_eval_${runId}_${++keyN}`);
    spent += res.costUsd ?? 0;
    const reasons = textReasons(res.value, mature);
    const classifier = callerOutcome(reasons, caller);
    const pipeline = rules.verdict === 'block' ? outcomeOf(rules) : classifier;
    return { ...base, classifier, pipeline, codes: [...new Set([...rules.reasons, ...reasons].map((r) => r.code))], assessment: res.value, ms: res.ms, ...(res.costUsd !== undefined && { costUsd: res.costUsd }) };
  } catch (err) {
    return { ...base, classifier: 'error', pipeline: rules.verdict === 'block' ? outcomeOf(rules) : 'error', codes: rules.reasons.map((r) => r.code), error: err instanceof Error ? err.message : String(err) };
  }
}

const queue = cases.flatMap((c) => CALLER_KINDS.map((caller) => [c, caller] as const));
const rows: Row[] = [];
let stopped = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (spent >= budget) {
        stopped++;
        continue;
      }
      rows.push(await runOne(...job));
    }
  }),
);
rows.sort((a, b) => a.id.localeCompare(b.id) || a.caller.localeCompare(b.caller));

const benign = rows.filter((r) => !r.truePositive);
const tps = rows.filter((r) => r.truePositive);
/** A benign case is a false positive when it blocks with a hard limit (mature_required on a non-mature caller is expected for explicit adult text). */
const fp = (level: 'classifier' | 'pipeline') => benign.filter((r) => r[level] === 'block');
const unexpectedMature = benign.filter((r) => r.classifier === 'mature_required' && r.expected !== 'mature_required');
const misses = (level: 'classifier' | 'pipeline') => tps.filter((r) => r[level] !== 'block');
const errors = rows.filter((r) => r.error);

const summary = {
  promptVersion: SAFETY_PROMPT_VERSION,
  model,
  calls: rows.length,
  skippedForBudget: stopped,
  spentUsd: +spent.toFixed(6),
  benignRows: benign.length,
  truePositiveRows: tps.length,
  falsePositives: { classifier: fp('classifier').map((r) => `${r.id}/${r.caller} ${r.codes.join(',')}`), pipeline: fp('pipeline').map((r) => `${r.id}/${r.caller} ${r.codes.join(',')}`) },
  unexpectedMatureRequired: unexpectedMature.map((r) => `${r.id}/${r.caller}`),
  misses: { classifier: misses('classifier').map((r) => `${r.id}/${r.caller} got ${r.classifier}`), pipeline: misses('pipeline').map((r) => `${r.id}/${r.caller} got ${r.pipeline}`) },
  errors: errors.map((r) => `${r.id}/${r.caller}: ${r.error}`),
};

const out = flag('out') ?? (() => {
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  return new URL(`./results/safety-fp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url).pathname;
})();
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
process.exit(fp('pipeline').length || misses('pipeline').length ? 1 : 0);
