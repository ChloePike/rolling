/**
 * Offline scorecards (no model calls):
 *
 *   pnpm --filter @rolling/agent eval:score                       scripted LLM, shots as fields and as prose
 *   pnpm --filter @rolling/agent eval:score -- --replay <file…>   grade recorded live results (evals/results/live-*.json)
 *
 * Prints one scorecard per run as JSON. Recorded files hold what a real model
 * wrote on an earlier harness; they are graded as stored (their plans are
 * applied to a canvas and planned as a run with today's code).
 */
import { readFileSync } from 'node:fs';
import { ScriptedLlm } from '../src/testkit';
import type { Proposal } from '../src/types';
import { ALL_CASES, evalWorld, gradeTurn, oracleSteps, runCase, scorecard, type Grade, type OracleStyle } from './index';

const args = process.argv.slice(2);
const replay = args.includes('--replay') ? args.slice(args.indexOf('--replay') + 1).filter((a) => !a.startsWith('--')) : [];
const verbose = args.includes('--failures');

async function scripted(style: OracleStyle) {
  const runs: { id: string; grades: Grade[] }[] = [];
  for (const c of ALL_CASES) {
    const world = evalWorld({ account: c.account ?? {}, editor: c.surface === 'editor', ...(c.canvas ? { canvas: c.canvas } : {}) });
    const run = await runCase(c, new ScriptedLlm(oracleSteps(c, world, false, style)), { world });
    runs.push({ id: c.id, grades: run.grades });
  }
  return runs;
}

interface Recorded {
  id: string;
  failures: string[];
  reason: string;
  text: string;
  trace: { name: string; ok: boolean; error?: string }[];
  proposal: Proposal | null;
}

async function recorded(file: string) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { runs: Recorded[] };
  const runs: { id: string; grades: Grade[] }[] = [];
  for (const r of data.runs) {
    const c = ALL_CASES.find((x) => x.id === r.id);
    if (!c) continue;
    const world = evalWorld({ account: c.account ?? {} });
    runs.push({ id: r.id, grades: await gradeTurn(c, { text: r.text, reason: r.reason, proposal: r.proposal, trace: r.trace }, { account: world.account, invariantFailures: r.failures }) });
  }
  return runs;
}

function print(label: string, runs: { id: string; grades: Grade[] }[]) {
  console.log(JSON.stringify({ run: label, ...scorecard(runs) }, null, 2));
  if (!verbose) return;
  for (const r of runs) for (const g of r.grades) if (!g.pass) console.log(`  ${r.id} ${g.grader} ${g.score.toFixed(2)}: ${g.failures.slice(0, 2).join(' | ')}`);
}

if (replay.length) {
  for (const file of replay) print(`recorded ${file.split('/').pop()}`, await recorded(file));
} else {
  print('scripted, shots as fields', await scripted('fields'));
  print('scripted, shots as prose', await scripted('prose'));
}
