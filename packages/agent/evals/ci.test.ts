/**
 * Deterministic eval runner (CI): every golden case runs through the real
 * harness loop with a scripted LLM, plus the harness paths (retry, invalid
 * proposal, max tool calls, cancel). Invariants must pass for all.
 */
import { describe, expect, it } from 'vitest';
import { runTurn } from '../src/loop';
import { ScriptedLlm, testIds } from '../src/testkit';
import { ALL_CASES, BRIEFS, BRIEFS_V2, CANVAS_CASES_V2, GRADER_IDS, NARRATION, oracleSteps, runCase, scorecard, sentRun, sharedPhrase, threadFor, TIMELINE_CASES, type EvalCase, type Grade } from './index';
import type { PlanBody } from '../src/types';
import { applyGraphOps } from '@rolling/core/project';
import { evalPorts, evalWorld } from './world';

describe('eval set', () => {
  it('has 40 golden briefs and the section 8 timeline cases', () => {
    expect(BRIEFS).toHaveLength(40);
    // Second set: ads, dramas with recurring characters, talking heads, holidays, pills, mature routing, hard limits, small talk, questions.
    expect(BRIEFS_V2).toHaveLength(31);
    expect(CANVAS_CASES_V2).toHaveLength(5);
    for (const kind of ['mature', 'recurring', 'dialogue'] as const) expect(BRIEFS_V2.some((c) => c.kind === 'plan' && c.expect[kind])).toBe(true);
    for (const b of ['smalltalk', 'clarify', 'refuse', 'mature_off']) expect(BRIEFS_V2.some((c) => c.kind === 'text' && c.expect.behavior === b)).toBe(true);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    expect(TIMELINE_CASES.map((c) => c.brief)).toEqual(expect.arrayContaining(['cut to 10s', 'swap shot 2 and 3', 'lower the music', 'make captions shorter']));
    expect(ALL_CASES.filter((c) => c.golden).map((c) => c.id)).toEqual(['tv-01-sparkling-water', 'cv-01-warmer', 'tl-01-cut-10']);
  });
});

describe('scripted eval run', () => {
  it.each(ALL_CASES.map((c, i) => [c.id, c, i] as const))('%s passes its invariants', async (_id, c: EvalCase, i) => {
    const world = evalWorld({ account: c.account ?? {}, ...(c.canvas ? { canvas: c.canvas } : {}) });
    const broken = c.kind === 'plan' && i % 5 === 0;
    const run = await runCase(c, new ScriptedLlm(oracleSteps(c, world, broken)), { world });
    expect(run.failures).toEqual([]);
    // Every grader that applies passes: structure, shots as fields, continuity, lengths, pills, per-model prompt format,
    // cost, reply text, no narration, mature routing.
    expect(run.grades.filter((g) => !g.pass).map((g) => `${g.grader}: ${g.failures.join(' | ')}`)).toEqual([]);
    const refusedOnce = c.kind === 'text' && c.expect.behavior === 'mature_off';
    expect(run.result.retries).toBe(broken || refusedOnce ? 1 : 0);
  });
});

describe('graders', () => {
  const grades = async (style: 'fields' | 'prose') => {
    const runs: { id: string; grades: Grade[] }[] = [];
    for (const c of ALL_CASES) {
      const world = evalWorld({ account: c.account ?? {}, ...(c.canvas ? { canvas: c.canvas } : {}) });
      runs.push({ id: c.id, grades: (await runCase(c, new ScriptedLlm(oracleSteps(c, world, false, style)), { world })).grades });
    }
    return scorecard(runs);
  };

  it('every grader runs on the set, and shots written as fields score full marks', async () => {
    const card = await grades('fields');
    expect(Object.keys(card.graders).sort()).toEqual([...GRADER_IDS].sort());
    expect(card.overall).toBe(1);
  });

  it('free-text shots lose on structure, continuity and prompt format (what the fields are for)', async () => {
    const card = await grades('prose');
    expect(card.graders.shots_structured!.score).toBe(0);
    expect(card.graders.continuity!.score).toBeLessThanOrEqual(0.5);
    // A keyframe of a free-text plan still gets every row of the script in its prompt.
    expect(card.graders.prompt_format!.score).toBeLessThan(0.75);
    expect(card.graders.no_narration!.score).toBe(1);
  });

  it('what a planned canvas would send: one composed prompt per node, in the model’s own format', async () => {
    const c = BRIEFS_V2.find((x) => x.id === 'ad-12-two-friends')!;
    const world = evalWorld();
    const run = await runCase(c, new ScriptedLlm(oracleSteps(c, world)), { world });
    const option = (run.result.proposal!.body as PlanBody).options[0]!;
    // Two recurring characters: one reference sheet each, wired into every keyframe that shows them.
    expect(option.ops.filter((o) => o.op === 'addNode' && o.title.startsWith('Character: ')).map((o) => (o.op === 'addNode' ? o.title : ''))).toEqual(['Character: Maya', 'Character: Leo']);
    const applied = applyGraphOps({ revision: 0, nodes: [], edges: [], groups: [] }, option.ops, { actor: 'agent' });
    if (!applied.ok) throw new Error('plan does not apply');
    const sent = await sentRun(applied.state, world.account);
    expect(sent.blocked).toEqual([]);
    expect(sent.prompts.every((p) => p.composed && p.issues.length === 0)).toBe(true);
    const key = sent.prompts.find((p) => p.title.startsWith('Keyframe 1:'))!;
    expect(key.prompt.startsWith('Image 1 is the character Maya: keep the face, hair and outfit identical. Image 2 is the character Leo')).toBe(true);
    const clip = sent.prompts.find((p) => p.title.startsWith('Shot 1:'))!;
    expect(clip).toMatchObject({ purpose: 'animate', model: 'bytedance/seedance-2.5' });
    expect(clip.prompt).toContain(`Maya's line (warm): "This is the one."`);
    expect(clip.prompt).not.toContain('short black hair');
    // The other option runs on another family and reads differently.
    const other = (run.result.proposal!.body as PlanBody).options[1]!;
    expect(other.shots[0]!.model).toBe('bytedance/seedance-2.0-mini');
    expect(option.estimate.items.filter((i) => i.ref.startsWith('char'))).toHaveLength(2);
  });

  it('narration patterns catch the recorded phrasings in several languages and leave plain replies alone', () => {
    const hit = (t: string) => NARRATION.some((re) => re.test(t));
    for (const t of ["I'll check the video models and their lengths before planning.", 'Let me look at the canvas first.', 'Checking models.', 'First, I will read the timeline.', '我先查看一下可用的模型。', 'まずモデルを確認します。', 'Ich prüfe zuerst die Modelle.', 'Voy a revisar los modelos.']) {
      expect(hit(t), t).toBe(true);
    }
    for (const t of ['Two options; building nodes is free.', 'This plan has 3 shots; the second option is the cheaper one.', 'Applying is free; running shot 2 again costs credits.', 'What should the video be about?']) {
      expect(hit(t), t).toBe(false);
    }
    expect(sharedPhrase(['A woman with short black hair walks', 'Close-up, a woman with short black hair smiles'])).toBe('woman with short black');
    expect(sharedPhrase(['A red car', 'A blue boat on the lake'])).toBeNull();
  });
});

describe('invariant checks catch bad output', () => {
  it('fails a plan with the wrong length and a timeline cut that misses the target', async () => {
    const plan = BRIEFS[0]!;
    const world = evalWorld();
    const wrong = new ScriptedLlm([
      {
        toolCalls: [
          {
            name: 'propose.plan',
            args: { seconds: 10, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', shots: [{ title: 'a', seconds: 10, visual: 'v', model: 'bytedance/seedance-2.5' }] })) },
          },
        ],
      },
    ]);
    const run = await runCase(plan, wrong, { world });
    expect(run.pass).toBe(false);
    expect(run.failures.join('\n')).toMatch(/10s, want 15s/);
    expect(run.failures.join('\n')).toMatch(/ratio 16:9, want 9:16/);

    const cut = TIMELINE_CASES[0]!;
    const half = new ScriptedLlm([{ toolCalls: [{ name: 'propose.timelinePatch', args: { canvasId: 'cnv_01JDEVALPROJECT000000000', baseRevision: 3, ops: [{ op: 'trim', clipId: 'v3', out: 3 }], summary: 'x' } }] }]);
    const r2 = await runCase(cut, half, { world: evalWorld() });
    expect(r2.failures.join('\n')).toMatch(/duration 15, want 10/);
  });

  it('fails a reply with emoji or a false claim', async () => {
    const c = BRIEFS.find((b) => b.kind === 'fields')!;
    const world = evalWorld();
    const steps = oracleSteps(c, world);
    (steps[0] as { text: string }).text = 'I have generated it 🎉';
    const run = await runCase(c, new ScriptedLlm(steps), { world });
    expect(run.failures).toEqual(expect.arrayContaining(['reply contains emoji', 'reply claims something was done']));
  });
});

describe('plan checks send the agent back with what to fix', () => {
  const c = BRIEFS[0]!;
  const shot = (over: Record<string, unknown> = {}) => ({ title: 'A', seconds: 5, model: 'bytedance/seedance-2.5', subject: 'Maya holding a bottle on a rock', action: 'Maya twists the cap off', cast: ['Maya'], ...over });
  const plan = (over: Record<string, unknown> = {}, shotOver: Record<string, unknown> = {}, seconds = 15) => ({
    seconds,
    options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '9:16', characters: [{ name: 'Maya', look: 'woman in her thirties, short black hair' }], shots: Array.from({ length: seconds / 5 }, () => shot(shotOver)), ...over })),
  });
  const run = async (args: unknown, input: Record<string, unknown> = {}, account = {}) => {
    const world = evalWorld({ account });
    const r = await runTurn({
      llm: new ScriptedLlm([{ toolCalls: [{ name: 'propose.plan', args }] }, { text: 'Fixing.' }]),
      ports: evalPorts(world),
      thread: threadFor(c),
      input: { text: 'An ad for sparkling water.', refs: [], selection: [], ...input },
      turnId: 't',
      newId: testIds(),
    });
    return r.trace[0]!;
  };

  it('accepts a sound plan', async () => {
    expect(await run(plan())).toMatchObject({ ok: true });
  });

  it('prompt box pills: ratio, length, resolution and model hold unless the brief names another', async () => {
    const settings = { ratio: '16:9', seconds: 30, resolution: '480p', videoModel: 'minimax/minimax-h3' };
    const t = await run(plan({ resolution: '720p' }), { settings });
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/ratio 9:16, but the prompt box says 16:9/);
    expect(t.error).toMatch(/seconds is 15, but the prompt box says 30 s/);
    expect(t.error).toMatch(/resolution 720p, but the prompt box says 480p/);
    expect(t.error).toMatch(/no option uses the model picked on the prompt box \(minimax\/minimax-h3\)/);
    // The brief's own words win over the pills.
    const own = await run(plan(), { text: 'A 15 second vertical ad for sparkling water, cheap model is fine.', settings: { ratio: '16:9', seconds: 30, videoModel: 'minimax/minimax-h3' } });
    expect(own).toMatchObject({ ok: true });
  });

  it('cast: unknown names and characters left out of cast', async () => {
    expect((await run(plan({}, { cast: ['Leo'] }))).error).toMatch(/cast "Leo" is not in this option's characters \(Maya\)/);
    expect((await run(plan({}, { cast: [] }))).error).toMatch(/Maya appears in the shot but is not in cast/);
  });

  it('speech needs a model with audio and has to fit the shot', async () => {
    const line = { dialogue: [{ speaker: 'Maya', line: 'Find your ridge.' }] };
    expect((await run(plan({}, { ...line, model: 'minimax/minimax-h3' }))).error).toMatch(/minimax\/minimax-h3 makes no sound/);
    const long = { dialogue: [{ speaker: 'Maya', line: 'This is a very long line that nobody could say in five seconds without rushing through every single word of it.' }] };
    expect((await run(plan({}, long))).error).toMatch(/spoken words do not fit 5 s/);
    expect(await run(plan({}, line))).toMatchObject({ ok: true });
  });

  it('a mature-allowed member’s explicit shot must use a length the mature models take', async () => {
    const explicit = { subject: 'Maya and her husband in a hotel bed, explicit sex scene', seconds: 6 };
    const t = await run({ ...plan({}, explicit, 12) }, { text: 'An explicit scene of two fictional adults, 12 seconds.' }, { matureAllowed: true });
    expect(t.error).toMatch(/mature clips run on models that take 5 or 8 seconds, not 6/);
  });
});

describe('harness paths', () => {
  const c = BRIEFS[0]!;
  const base = () => {
    const world = evalWorld();
    return { world, ports: evalPorts(world), thread: threadFor(c), input: { text: c.brief, refs: c.refs ?? [], selection: [] }, newId: testIds() };
  };

  it('invalid proposal three times ends with an explanation and no proposal', async () => {
    const b = base();
    const bad = { toolCalls: [{ name: 'propose.plan', args: { options: [] } }] };
    const r = await runTurn({ ...b, turnId: 't', llm: new ScriptedLlm([bad, bad, bad, { text: 'That plan does not fit the models.' }]) });
    expect(r).toMatchObject({ reason: 'invalid_proposal', proposal: null, retries: 3 });
  });

  it('max tool calls ends the turn', async () => {
    const b = base();
    const read = { toolCalls: [{ name: 'models.capabilities', args: { kind: 'video' } }] };
    const r = await runTurn({ ...b, turnId: 't', llm: new ScriptedLlm([read, read, read, read, read, read, read, read, { text: 'Stopping here.' }]) });
    expect(r).toMatchObject({ reason: 'max_tool_calls', toolCalls: 8, proposal: null });
  });

  it('cancel creates no proposal', async () => {
    const b = base();
    const controller = new AbortController();
    const steps = oracleSteps(c, b.world);
    const slow = { ...(steps[0] as object), delayMs: 1_000 };
    const p = runTurn({ ...b, turnId: 't', signal: controller.signal, llm: new ScriptedLlm([slow, ...steps.slice(1)]) });
    setTimeout(() => controller.abort(), 20);
    const r = await p;
    expect(r).toMatchObject({ reason: 'canceled', proposal: null });
  });
});
