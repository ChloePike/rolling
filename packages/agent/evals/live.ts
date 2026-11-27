/**
 * Live eval: runs every case against Hyperouter through the core adapter.
 *
 *   HYPEROUTER_API_KEY=... pnpm --filter @rolling/agent eval:live [--llm deepseek-v4.1-flash] [--only tv-01,cv-01] [--concurrency 4] [--repeat 1] [--budget 1] [--rules-only] [--debug]
 *
 * The key may also be in HYPEROUTER_KEY (the name the cloud sessions use).
 * `--budget` stops starting new cases once the gateway cost reaches that many
 * USD. The D-005 gate uses the real text classifier unless `--rules-only`.
 * LLM turns only: nothing is generated.
 *
 * Writes evals/results/live-<timestamp>.json and prints pass rate, tokens per
 * turn and failures. Exit code 1 when the invariant pass rate is below 90%.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { hyperouter } from '@rolling/core';

const { HyperouterLlmProvider } = hyperouter;
import { createSafetyGate } from '@rolling/core/safety';
import { ALL_CASES, catalog, runCase, type CaseRun } from './index';

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
const llmId = flag('llm') ?? 'deepseek-v4.1-flash';
const only = flag('only')?.split(',');
const concurrency = Number(flag('concurrency') ?? 4);
const repeat = Number(flag('repeat') ?? 1);
const budget = Number(flag('budget') ?? 1);
const rulesOnly = args.includes('--rules-only');
const cases = ALL_CASES.filter((c) => !only || only.some((o) => c.id.startsWith(o)));
const llm = new HyperouterLlmProvider({ apiKey, ...(process.env.HYPEROUTER_BASE_URL ? { baseUrl: process.env.HYPEROUTER_BASE_URL.replace(/\/v1$/, '') } : {}) });

// Classifier calls of the safety gate are counted in the spend.
let gateCost = 0;
const metered: typeof llm = Object.assign(Object.create(llm), {
  async *chat(req: Parameters<typeof llm.chat>[0]) {
    for await (const ev of llm.chat(req)) {
      if (ev.type === 'usage') gateCost += ev.usage.costUsd ?? 0;
      yield ev;
    }
  },
});
let keyN = 0;
const safety = rulesOnly ? undefined : createSafetyGate({ llm: metered, chatModels: catalog.models.filter((m) => m.kind === 'chat'), newKey: () => `eval_safety_${Date.now()}_${++keyN}` });
let spent = 0;

/** `--debug`: one line per LLM call with what came back (text, reasoning, tool calls, finish reason). */
const debug = args.includes('--debug');
const agentLlm: typeof llm = !debug
  ? llm
  : Object.assign(Object.create(llm), {
      async *chat(req: Parameters<typeof llm.chat>[0]) {
        let text = '';
        let reasoning = 0;
        const calls: string[] = [];
        for await (const ev of llm.chat(req)) {
          if (ev.type === 'text') text += ev.delta;
          else if (ev.type === 'reasoning') reasoning += ev.delta.length;
          else if (ev.type === 'tool_call') calls.push(`${ev.call.name}(${ev.call.arguments.length} chars${ev.call.name.startsWith('propose') ? `, ends ${JSON.stringify(ev.call.arguments.slice(-160))}` : ''})`);
          if (ev.type === 'tool_call' && ev.call.name.startsWith('propose')) {
            // Raw arguments of every propose call, for diagnosing input the server could not read.
            mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
            writeFileSync(new URL(`./results/debug-${String(req.idempotencyKey).replace(/[^\w-]/g, '_')}.args.txt`, import.meta.url), ev.call.arguments);
          }
          else if (ev.type === 'error') console.error(`  [debug ${req.idempotencyKey}] error ${ev.error.code}: ${ev.error.message}`);
          else if (ev.type === 'done') console.error(`  [debug ${req.idempotencyKey}] finish=${ev.finishReason} text=${JSON.stringify(text.slice(0, 300))} reasoning=${reasoning} chars calls=${calls.join(', ') || 'none'}`);
          yield ev;
        }
      },
    });

const queue = Array.from({ length: repeat }, () => cases).flat();
const runs: CaseRun[] = [];
const started = Date.now();

async function worker() {
  for (;;) {
    if (spent + gateCost >= budget) {
      if (queue.length) console.error(`budget of $${budget} reached; ${queue.length} case(s) not run`);
      queue.length = 0;
      return;
    }
    const c = queue.shift();
    if (!c) return;
    let run: CaseRun;
    try {
      run = await runCase(c, agentLlm, { llmId, ...(safety ? { safety } : {}) });
    } catch (err) {
      console.error(`${c.id}: crashed`, err);
      continue;
    }
    runs.push(run);
    const r = run.result;
    spent += r.usage.costUsd ?? r.usage.chargedUsd;
    console.log(
      `${run.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(26)} ${r.reason.padEnd(16)} calls=${r.llmCalls} tools=${r.toolCalls} retries=${r.retries} in=${r.usage.promptTokens} out=${r.usage.completionTokens} ${(r.latencyMs / 1000).toFixed(1)}s`,
    );
    if (!run.pass) for (const f of run.failures) console.log(`     - ${f}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const n = runs.length;
const pass = runs.filter((r) => r.pass).length;
const sum = (f: (r: CaseRun) => number) => runs.reduce((s, r) => s + f(r), 0);
const tokensIn = sum((r) => r.result.usage.promptTokens);
const tokensOut = sum((r) => r.result.usage.completionTokens);
const cost = sum((r) => r.result.usage.costUsd ?? r.result.usage.chargedUsd);
const summary = {
  llm: llmId,
  gateway: runs[0]?.result.llm.gatewayId,
  cases: n,
  passed: pass,
  passRate: n ? pass / n : 0,
  golden: runs.filter((r) => r.golden).map((r) => ({ id: r.id, pass: r.pass, failures: r.failures })),
  byKind: Object.fromEntries(
    ['plan', 'fields', 'graphPatch', 'timeline'].map((k) => {
      const rs = runs.filter((r) => r.kind === k);
      return [k, { cases: rs.length, passed: rs.filter((r) => r.pass).length }];
    }),
  ),
  perTurn: {
    tokensIn: n ? Math.round(tokensIn / n) : 0,
    tokensOut: n ? Math.round(tokensOut / n) : 0,
    contextTokensEstimated: n ? Math.round(sum((r) => r.result.contextTokens) / n) : 0,
    llmCalls: n ? +(sum((r) => r.result.llmCalls) / n).toFixed(2) : 0,
    toolCalls: n ? +(sum((r) => r.result.toolCalls) / n).toFixed(2) : 0,
    latencyMs: n ? Math.round(sum((r) => r.result.latencyMs) / n) : 0,
    costUsd: n ? +(cost / n).toFixed(6) : 0,
  },
  totalCostUsd: +cost.toFixed(5),
  safetyClassifier: rulesOnly ? 'rules only' : 'live',
  safetyCostUsd: +gateCost.toFixed(5),
  wallMs: Date.now() - started,
  failures: runs.filter((r) => !r.pass).map((r) => ({ id: r.id, reason: r.result.reason, failures: r.failures, text: r.result.text.slice(0, 300) })),
};

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(
  file,
  JSON.stringify(
    {
      summary,
      runs: runs.map((r) => {
        const t = r.result;
        return { id: r.id, pass: r.pass, failures: r.failures, reason: t.reason, text: t.text, error: t.error, trace: t.trace, usage: t.usage, llm: t.llm, llmCalls: t.llmCalls, toolCalls: t.toolCalls, retries: t.retries, latencyMs: t.latencyMs, contextTokens: t.contextTokens, proposal: t.proposal };
      }),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ ...summary, failures: summary.failures.map((f) => `${f.id}: ${f.failures.join('; ')}`) }, null, 2));
console.log(`wrote ${file.pathname}`);
process.exit(summary.passRate >= 0.9 ? 0 : 1);
