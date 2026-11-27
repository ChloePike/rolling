/**
 * Readable transcripts of recorded live results, for judging by reading (no
 * model calls):
 *
 *   pnpm --filter @rolling/agent eval:read <results file…> [--only tv-01,dr-] [--full | --digest]
 *
 * Writes `<results file>.md` next to each file (git-ignored): per case the
 * brief, the reply, the tool trace with every refused proposal, the plan as
 * shot fields, the prompts a run would send to each model (composed by
 * `core/prompting`), the estimate and the offline grades.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolTraceEntry } from '../src/loop';
import type { PlanBody, Proposal } from '../src/types';
import { ALL_CASES, canvasesOf, evalWorld, gradeTurn, sentRun } from './index';

interface Recorded {
  id: string;
  failures: string[];
  reason: string;
  text: string;
  trace: ToolTraceEntry[];
  usage?: { promptTokens: number; completionTokens: number; costUsd: number | null };
  llm?: { gatewayId: string };
  llmCalls?: number;
  toolCalls?: number;
  retries?: number;
  latencyMs?: number;
  proposal: Proposal | null;
}

const args = process.argv.slice(2);
const full = args.includes('--full');
const digest = args.includes('--digest');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]!.split(',') : null;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');

const one = (v: unknown) => JSON.stringify(v);

/** One short block per case: enough to see the plan's shape and where to look closer. */
async function renderDigest(r: Recorded): Promise<string> {
  const c = ALL_CASES.find((x) => x.id === r.id);
  if (!c) return '';
  const world = evalWorld({ account: c.account ?? {} });
  const cut = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n)}…`);
  const out: string[] = [`## ${r.id} [${r.reason}; calls ${r.llmCalls ?? '?'}, retries ${r.retries ?? '?'}, in ${r.usage?.promptTokens ?? '?'}, out ${r.usage?.completionTokens ?? '?'}]`, `Brief: ${c.brief}${c.settings ? ` PILLS ${one(c.settings)}` : ''}`, `Reply: ${r.text}`];
  for (const t of r.trace) if (!t.ok) out.push(`REFUSED ${t.name}: ${cut(t.error ?? '', 260)}`);
  const p = r.proposal;
  if (p?.body.kind === 'plan') {
    for (const [i, o] of (p.body as PlanBody).options.entries()) {
      const models = [...new Set(o.shots.map((s) => `${s.model.split('/')[1]} ${s.resolution ?? ''}`))].join(', ');
      out.push(`Opt ${i} "${o.title}" ${o.ratio} ${o.shots.map((s) => s.seconds).join('+')}=${o.seconds}s ${o.estimate.credits}cr ${models} | look: ${o.look ?? '-'}`);
      for (const ch of o.characters ?? []) if (i === 0) out.push(`  char ${ch.name}: ${cut(ch.look, 120)}${ch.wardrobe ? ` | W: ${cut(ch.wardrobe, 70)}` : ''}`);
      if (i > 0 && o.characters?.length) out.push(`  chars: ${o.characters.map((x) => x.name).join(', ')}`);
      for (const s of o.shots) {
        const sh = s.shot;
        if (!sh) {
          out.push(`  ${s.n} FREE TEXT ${cut(s.visual, 120)}`);
          continue;
        }
        const cam = [sh.camera?.size, sh.camera?.move].filter(Boolean).join('/');
        const says = (sh.dialogue ?? []).map((d) => `SAYS ${d.speaker}: "${d.line}"`).join(' ');
        const bits = [`  ${s.n} ${s.seconds}s${s.audio ? ' aud' : ''} ${cam}`, i === 0 ? `S: ${cut(sh.subject, 100)}` : '', `A: ${cut(sh.action, i === 0 ? 110 : 60)}`, sh.characters?.length ? `[${sh.characters.map((x) => x.name).join(', ')}]` : '', says, sh.text ? `TEXT "${sh.text}"` : '', i === 0 && s.line ? `line: ${cut(s.line, 70)}` : ''];
        out.push(bits.filter(Boolean).join(' | '));
      }
    }
  } else if (p) {
    out.push(`Proposal ${p.kind} ${p.estimate.credits}cr: ${cut(JSON.stringify((p.body as { ops?: unknown; fields?: unknown }).ops ?? (p.body as { fields?: unknown }).fields ?? p.body), 1100)}`);
  }
  for (const cv of canvasesOf(c, p).slice(0, 1)) {
    const run = await sentRun(cv.state, world.account);
    for (const b of run.blocked) out.push(`BLOCKED ${b}`);
    let shown = 0;
    for (const s of run.prompts) {
      if (cv.only && !cv.only.has(s.ref)) continue;
      const notable = (s.kind === 'video' && (/"/.test(s.prompt) || !s.model.includes('seedance'))) || s.mature || !!cv.only;
      if (!notable || shown++ >= 3) continue;
      out.push(`SENT ${s.title} [${s.model.split('/')[1]}, ${s.purpose}${s.mature ? ', mature' : ''}${s.chain ? `, ${s.chain}` : ''}]: ${cut(s.prompt, 420)}`);
    }
  }
  const grades = await gradeTurn(c, { text: r.text, reason: r.reason, proposal: r.proposal, trace: r.trace }, { account: world.account, invariantFailures: r.failures });
  const bad = grades.filter((g) => !g.pass);
  if (bad.length) out.push(`GRADES ${bad.map((g) => `${g.grader} ${g.score.toFixed(2)} (${cut([...new Set(g.failures.map((f) => f.replace(/^option \d+ /, '').replace(/\[[^\]]*\]/, '')))].slice(0, 2).join(' / '), 200)})`).join('; ')}`);
  return out.join('\n');
}

async function render(r: Recorded): Promise<string> {
  if (digest) return renderDigest(r);
  const c = ALL_CASES.find((x) => x.id === r.id);
  if (!c) return '';
  const world = evalWorld({ account: c.account ?? {} });
  const out: string[] = [`## ${r.id}`, '', `Brief (${c.surface}${c.skill ? `, ${c.skill}` : ''}): ${c.brief}`];
  if (c.settings) out.push(`Pills: ${one(c.settings)}`);
  if (c.account) out.push(`Account: ${one(c.account)}`);
  out.push(
    `Turn: ${r.reason}; llm calls ${r.llmCalls ?? '?'}, tools ${r.toolCalls ?? r.trace.length}, retries ${r.retries ?? r.trace.filter((t) => !t.ok && t.name.startsWith('propose')).length}, tokens in ${r.usage?.promptTokens ?? '?'} out ${r.usage?.completionTokens ?? '?'}, ${r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} s` : ''} ${r.llm?.gatewayId ?? ''}`,
    '',
    `Reply: ${r.text || '(empty)'}`,
    '',
    'Trace:',
    ...r.trace.map((t) => `- ${t.name} ${t.ok ? 'ok' : `REFUSED: ${t.error}`}`),
  );
  const p = r.proposal;
  if (p?.body.kind === 'plan') {
    const plan = p.body as PlanBody;
    out.push('', `Plan: ${plan.seconds} s asked, ${plan.options.length} options`);
    for (const [i, o] of plan.options.entries()) {
      out.push('', `### Option ${i}: ${o.title} (${o.ratio}, ${o.seconds} s, ${o.estimate.credits} credits)`);
      if (o.look) out.push(`Look: ${o.look}`);
      for (const ch of o.characters ?? []) out.push(`Character ${ch.name}: ${ch.look}${ch.wardrobe ? ` | wardrobe: ${ch.wardrobe}` : ''}`);
      for (const s of o.shots) {
        const sh = s.shot;
        const head = `- ${s.n} "${s.title}" ${s.seconds}s ${s.model.split('/')[1]} ${s.mode} ${s.resolution ?? ''}${s.audio ? ' audio' : ''}`;
        if (!sh) {
          out.push(`${head} | free text: ${s.visual}`);
          continue;
        }
        const cam = sh.camera ? [sh.camera.size, sh.camera.angle, sh.camera.move, sh.camera.lens].filter(Boolean).join('/') : '';
        // The first option in full; the others without setting and lighting unless --full.
        const whole = i === 0 || full;
        const clip = (t: string) => (whole || t.length <= 90 ? t : `${t.slice(0, 90)}…`);
        const parts: (string | false | undefined)[] = [head, whole && `S: ${sh.subject}`, `A: ${clip(sh.action)}`, cam && `cam: ${cam}`];
        if (whole) parts.push(sh.setting && `set: ${sh.setting}`, sh.lighting && `light: ${sh.lighting}`);
        parts.push(sh.characters?.length ? `cast: ${sh.characters.map((x) => x.name).join(', ')}` : '');
        for (const d of sh.dialogue ?? []) parts.push(`SAYS ${d.speaker}${d.tone ? ` (${d.tone})` : ''}: "${d.line}"`);
        parts.push(whole && sh.sound && `sound: ${sh.sound}`, sh.text && `text: ${sh.text}`, whole && s.line && `line: ${s.line}`);
        out.push(parts.filter(Boolean).join(' | '));
      }
    }
  } else if (p) {
    out.push('', `Proposal (${p.kind}, ${p.estimate.credits} credits): ${p.summary}`, '```json', JSON.stringify(p.body).slice(0, full ? 8000 : 2500), '```');
  }
  // What a run would send. Compact: the first option's character sheets, its first keyframe and clip, and every
  // prompt with speech or a lint issue; --full prints every prompt of two options.
  for (const cv of canvasesOf(c, p).slice(0, full ? 2 : 1)) {
    const run = await sentRun(cv.state, world.account);
    out.push('', `Sent prompts, ${cv.label}${full ? '' : ' (sample)'}:`);
    for (const b of run.blocked) out.push(`- BLOCKED ${b}`);
    const seen = { sheet: 0, still: 0, clip: 0 };
    for (const s of run.prompts) {
      if (cv.only && !cv.only.has(s.ref)) continue;
      const slot = s.title.startsWith('Character') ? 'sheet' : s.kind === 'image' ? 'still' : 'clip';
      const notable = s.issues.length > 0 || (s.kind === 'video' && /"/.test(s.prompt)) || s.mature;
      if (!full && !cv.only && seen[slot]++ >= 1 && !notable) continue;
      out.push(`- ${s.title} [${s.model.split('/')[1]}, ${s.purpose}${s.mature ? ', mature' : ''}${s.chain ? `, ${s.chain}` : ''}, ${s.prompt.split(/\s+/).length} words]: ${full || s.prompt.length <= 380 ? s.prompt : `${s.prompt.slice(0, 380)}…`}`);
      if (s.negativePrompt) out.push(`  - negative: ${s.negativePrompt.slice(0, 80)}`);
      for (const issue of s.issues) out.push(`  - LINT ${issue.code}: ${issue.detail}`);
    }
  }
  const grades = await gradeTurn(c, { text: r.text, reason: r.reason, proposal: r.proposal, trace: r.trace }, { account: world.account, invariantFailures: r.failures });
  out.push('', `Grades: ${grades.map((g) => `${g.grader} ${g.score.toFixed(2)}`).join(', ')}`);
  for (const g of grades) for (const f of g.failures) out.push(`- ${g.grader}: ${f}`);
  return out.join('\n');
}

for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { summary: unknown; runs: Recorded[] };
  const order = new Map(ALL_CASES.map((c, i) => [c.id, i]));
  const runs = data.runs.filter((r) => !only || only.some((o) => r.id.startsWith(o))).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const parts: string[] = [`# ${file.split('/').pop()}`, '', JSON.stringify((data.summary as { perTurn?: unknown }).perTurn ?? {})];
  for (const r of runs) parts.push('', await render(r));
  const outFile = `${file}${digest ? '.digest' : ''}.md`;
  writeFileSync(outFile, parts.join('\n'));
  console.log(`wrote ${outFile} (${runs.length} cases)`);
}
