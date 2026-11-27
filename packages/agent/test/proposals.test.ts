import { describe, expect, it } from 'vitest';
import { applyGraphOps } from '@rolling/core/project';
import { applyOps, edlDuration } from '@rolling/core/timeline';
import { planCutTo } from '@rolling/core/timeline';
import { rebaseGraphPatch, runPropose, type ProposeContext } from '../src/proposals';
import type { GraphPatchBody, PlanBody, TimelinePatchBody, FieldsBody } from '../src/types';
import { CANVAS_ID, evalPorts, evalWorld, PRODUCT_PHOTO, PROJECT_ID, sampleGraph } from '../evals/world';

function ctx(surface: ProposeContext['thread']['surface'], over: Partial<ProposeContext> = {}, accountOver = {}): ProposeContext {
  const world = evalWorld({ account: accountOver });
  let n = 0;
  return {
    ports: evalPorts(world),
    account: world.account,
    thread: { surface, projectId: surface === 'home' || surface === 'tool' ? null : PROJECT_ID, canvasId: surface === 'editor' ? CANVAS_ID : null },
    newId: () => `prop_t${++n}`,
    now: () => 1_000,
    refs: [],
    userText: '',
    ...over,
  };
}

const shot = (title: string, seconds: number, model = 'bytedance/seedance-2.5') => ({ title, seconds, visual: `${title} visual`, model });

describe('propose.plan', () => {
  it('builds options with estimates and GraphOps that apply to an empty project', async () => {
    const res = await runPropose(
      'propose.plan',
      {
        seconds: 15,
        options: [
          { title: 'Riverside', ratio: '9:16', shots: [shot('Hook', 4), shot('Cap pop', 5), shot('Logo', 6)] },
          { title: 'Kitchen', ratio: '9:16', shots: [shot('Fridge', 5, 'bytedance/seedance-2.0-mini'), shot('Pour', 5, 'bytedance/seedance-2.0-mini'), shot('Logo', 5, 'bytedance/seedance-2.0-mini')] },
        ],
      },
      ctx('home', { refs: [PRODUCT_PHOTO] }),
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const body = res.proposal.body as PlanBody;
    expect(body.options).toHaveLength(2);
    const a = body.options[0]!;
    expect(a.seconds).toBe(15);
    expect(a.estimate.credits).toBeGreaterThan(0);
    expect(a.estimate.items.filter((i) => i.kind === 'video')).toHaveLength(3);
    expect(a.estimate.items.filter((i) => i.kind === 'image')).toHaveLength(3);
    // Plus plan, model default resolution.
    expect(a.shots.every((s) => s.resolution === '480p' && s.mode === 'i2v')).toBe(true);
    const applied = applyGraphOps({ revision: 0, nodes: [], edges: [], groups: [] }, a.ops, { actor: 'agent' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.nodes.map((n) => n.kind).sort()).toEqual(['asset', 'image', 'image', 'image', 'script', 'video', 'video', 'video']);
    // Laid out left to right: script and ref, then keyframes, then videos.
    const x = (kind: string) => Math.min(...applied.state.nodes.filter((n) => n.kind === kind).map((n) => n.position.x));
    expect(x('script')).toBeLessThan(x('image'));
    expect(x('image')).toBeLessThan(x('video'));
    // Keyframes use the product photo as a reference.
    expect(applied.state.edges.filter((e) => e.to.port === 'refs')).toHaveLength(3);
    expect(res.proposal.estimate.credits).toBe(Math.min(...body.options.map((o) => o.estimate.credits)));
  });

  it('gives a text-to-video shot no keyframe: no image node to run and no keyframe in the estimate', async () => {
    const lite = 'x-ai/grok-imagine-video-1.5-lite';
    const res = await runPropose('propose.plan', { seconds: 5, options: [{ title: 'A', ratio: '16:9', shots: [shot('Hook', 5, lite)] }, { title: 'B', ratio: '16:9', shots: [shot('Hook', 5)] }] }, ctx('home'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const [t2v, i2v] = (res.proposal.body as PlanBody).options;
    expect(t2v!.shots[0]!.mode).toBe('t2v');
    expect(t2v!.estimate.items.map((i) => i.kind)).toEqual(['video']);
    expect(t2v!.ops.filter((o) => o.op === 'addNode').map((o) => (o as { kind: string }).kind)).toEqual(['script', 'video']);
    // The i2v option keeps its keyframe, wired into the shot's frame.
    expect(i2v!.estimate.items.map((i) => i.kind).sort()).toEqual(['image', 'video']);
    expect(i2v!.ops.some((o) => o.op === 'connect' && o.to.port === 'frame')).toBe(true);
  });

  it('refuses lengths a model does not take, with the allowed range', async () => {
    const res = await runPropose('propose.plan', { seconds: 6, options: [{ title: 'A', ratio: '16:9', shots: [shot('Hook', 3), shot('End', 3)] }, { title: 'B', ratio: '16:9', shots: [shot('Hook', 6)] }] }, ctx('home'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('from 4 to 15');
  });

  it('refuses unknown models and face/head swap models (not offered)', async () => {
    const res = await runPropose(
      'propose.plan',
      { seconds: 5, options: [{ title: 'A', ratio: '16:9', shots: [shot('x', 5, 'acme/video-9')] }, { title: 'B', ratio: '16:9', shots: [shot('x', 5, 'lumina/video-face-swap')] }] },
      ctx('home'),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('model "acme/video-9" is not in the catalog');
    expect(res.error).toContain('model "lumina/video-face-swap" is not in the catalog');
  });

  it('enforces plan resolution caps (D-006)', async () => {
    const res = await runPropose(
      'propose.plan',
      { seconds: 5, options: [{ title: 'A', ratio: '16:9', resolution: '1080p', shots: [shot('x', 5)] }, { title: 'B', ratio: '16:9', shots: [shot('y', 5, 'bytedance/seedance-2.0-mini')] }] },
      ctx('home', {}, { plan: 'starter' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 1080p is not allowed on Starter: the error names the allowed resolutions.
    expect(res.error).toContain('1080p needs the plus plan; this plan allows 480p, 720p');
  });

  it('refuses models whose default resolution is above the plan cap', async () => {
    const res = await runPropose('propose.plan', { seconds: 5, options: [{ title: 'A', ratio: '16:9', shots: [shot('x', 5, 'minimax/minimax-h3')] }, { title: 'B', ratio: '16:9', shots: [shot('y', 5)] }] }, ctx('home', {}, { plan: 'starter' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/768p needs the plus plan/);
  });

  it('refuses mature-only models without mature access (D-005)', async () => {
    const res = await runPropose(
      'propose.fields',
      { tool: 'quick', fields: { kind: 'image', prompt: 'portrait', model: 'lumina/z-image-spicy' } },
      ctx('tool'),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('not available for this account');
  });

  it('flags estimates above the balance and the confirm threshold', async () => {
    const res = await runPropose('propose.plan', { seconds: 30, options: [{ title: 'A', ratio: '16:9', shots: [shot('x', 8), shot('y', 8), shot('x2', 7), shot('y2', 7)] }, { title: 'B', ratio: '16:9', shots: [shot('z', 8), shot('w', 8), shot('z2', 7), shot('w2', 7)] }] }, ctx('home', {}, { balance: { plan: 100, purchased: 0, held: 0 } }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const opt = (res.proposal.body as PlanBody).options[0]!;
    expect(opt.estimate.balanceAfter).toBeLessThan(0);
    expect(opt.estimate.needsConfirm).toBe(true);
  });
});

describe('propose.graphPatch', () => {
  const base = { projectId: PROJECT_ID, baseRevision: 7, summary: 'Warmer shot 2' };

  it('accepts a valid update and prices the changed node', async () => {
    const res = await runPropose('propose.graphPatch', { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { prompt: 'Close-up, warm golden light' } }] }, ctx('canvas'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.proposal.baseRevision).toBe(7);
    expect(res.proposal.estimate.items).toEqual([expect.objectContaining({ ref: 'node_shot2', model: 'bytedance/seedance-2.5', seconds: 5, resolution: '720p' })]);
    const body = res.proposal.body as GraphPatchBody;
    expect(body.touched.updated).toEqual(['node_shot2']);
  });

  it('places added nodes by dependency and ignores model coordinates', async () => {
    const res = await runPropose(
      'propose.graphPatch',
      {
        ...base,
        ops: [
          { op: 'addNode', tempId: 't1', kind: 'video', title: 'Shot 3', params: { prompt: 'Logo', model: 'bytedance/seedance-2.5', seconds: 4, mode: 'i2v' }, position: { x: -9999, y: 5 } },
          { op: 'connect', from: { node: 'node_key1', port: 'out' }, to: { node: 't1', port: 'frame' } },
        ],
      },
      ctx('canvas'),
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const add = (res.proposal.body as GraphPatchBody).ops[0] as { position: { x: number; y: number } };
    expect(add.position.x).toBe(436 + 340);
    expect(add.position.y).toBeGreaterThan(356);
  });

  it('returns port and cycle errors from core validation', async () => {
    const res = await runPropose('propose.graphPatch', { ...base, ops: [{ op: 'connect', from: { node: 'node_shot1', port: 'out' }, to: { node: 'node_key1', port: 'refs' } }] }, ctx('canvas'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/PORT_TYPE_MISMATCH|CYCLE/);
  });

  it('refuses a stale baseRevision', async () => {
    const res = await runPropose('propose.graphPatch', { ...base, baseRevision: 3, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { seconds: 6 } }] }, ctx('canvas'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('revision 7');
  });

  it('refuses invalid model settings', async () => {
    const res = await runPropose('propose.graphPatch', { ...base, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { seconds: 40 } }] }, ctx('canvas'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('from 4 to 15');
  });

  it('removes user nodes only when asked', async () => {
    const ops = [{ op: 'removeNode', nodeId: 'node_photo' }];
    expect((await runPropose('propose.graphPatch', { ...base, ops }, ctx('canvas', { userText: 'make it warmer' }))).ok).toBe(false);
    const asked = await runPropose('propose.graphPatch', { ...base, ops }, ctx('canvas', { userText: 'delete the product photo' }));
    expect(asked.ok).toBe(true);
    if (asked.ok) expect(asked.proposal.risks.map((r) => r.code)).toContain('removes_user_nodes');
  });

  it('rejects moveNode (not an agent op)', async () => {
    const res = await runPropose('propose.graphPatch', { ...base, ops: [{ op: 'moveNode', nodeId: 'node_shot2', position: { x: 1, y: 1 } }] }, ctx('canvas'));
    expect(res.ok).toBe(false);
  });

  it('rebases onto a newer revision when the ops still apply, else stale', () => {
    const body: GraphPatchBody = { kind: 'graphPatch', projectId: PROJECT_ID, ops: [{ op: 'updateNode', nodeId: 'node_shot2', params: { prompt: 'x' } }], touched: { added: [], updated: ['node_shot2'], removed: [], edges: 0 } };
    expect(rebaseGraphPatch(body, sampleGraph(9))).toEqual({ ok: true, revision: 9 });
    const gone = sampleGraph(10);
    gone.nodes = gone.nodes.filter((n) => n.id !== 'node_shot2');
    expect(rebaseGraphPatch(body, gone).ok).toBe(false);
  });
});

describe('propose.timelinePatch', () => {
  it('accepts a cut to 10s planned by core and reports durations and highlights', async () => {
    const world = evalWorld();
    const edl = world.timelines.get(CANVAS_ID)!.edl;
    const plan = planCutTo(edl, 10)!;
    const res = await runPropose('propose.timelinePatch', { canvasId: CANVAS_ID, baseRevision: 3, ops: plan.ops, summary: 'Cut to 10 s' }, ctx('editor'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const body = res.proposal.body as TimelinePatchBody;
    expect(body.durationBefore).toBe(15);
    expect(body.durationAfter).toBe(10);
    expect(res.proposal.estimate.credits).toBe(0);
    expect(body.highlights.length).toBeGreaterThan(0);
    expect(applyOps(edl, body.ops).ok).toBe(true);
    expect(edlDuration(edl)).toBe(15);
  });

  it('refuses overlaps', async () => {
    const res = await runPropose('propose.timelinePatch', { canvasId: CANVAS_ID, baseRevision: 3, ops: [{ op: 'move', clipId: 'v2', start: 2 }], summary: 'x' }, ctx('editor'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('overlap');
  });

  it('refuses unknown clips', async () => {
    const res = await runPropose('propose.timelinePatch', { canvasId: CANVAS_ID, baseRevision: 3, ops: [{ op: 'remove', clipId: 'v9', ripple: true }], summary: 'x' }, ctx('editor'));
    expect(res.ok).toBe(false);
  });
});

describe('propose.fields', () => {
  it('validates per-tool fields and estimates quick runs', async () => {
    const res = await runPropose('propose.fields', { tool: 'quick', fields: { kind: 'video', prompt: 'A cat on a skateboard', model: 'bytedance/seedance-2.5', seconds: 5 } }, ctx('tool'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect((res.proposal.body as FieldsBody).fields.prompt).toBe('A cat on a skateboard');
    expect(res.proposal.estimate.credits).toBeGreaterThan(0);
  });

  it('refuses missing required fields', async () => {
    const res = await runPropose('propose.fields', { tool: 'avatar', fields: { look: 'friendly' } }, ctx('tool'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('script');
  });
});

describe('decodeJsonStrings', () => {
  it('decodes arrays sent as strings and repairs an object tail inside a string', async () => {
    const { decodeJsonStrings } = await import('../src/proposals');
    expect(decodeJsonStrings({ options: '[{"a":1}]' })).toEqual({ options: [{ a: 1 }] });
    expect(decodeJsonStrings({ options: '[{"a":1}], "summary": "x"}' })).toEqual({ options: [{ a: 1 }], summary: 'x' });
    expect(decodeJsonStrings({ visual: '[not json' })).toEqual({ visual: '[not json' });
    expect(decodeJsonStrings({ options: '[{"a":1}], "seconds" string="false">6', summary: 's' })).toEqual({ options: [{ a: 1 }], seconds: 6, summary: 's' });
  });
});

describe('plan length and budget checks', () => {
  it('refuses options that miss the target length', async () => {
    const res = await runPropose('propose.plan', { seconds: 6, options: [{ title: 'A', ratio: '16:9', shots: [shot('a', 4), shot('b', 4)] }, { title: 'B', ratio: '16:9', shots: [shot('c', 6)] }] }, ctx('home'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('options[0]: shots add up to 8s, but the target is 6s');
  });

  it('refuses plans where every option is over the balance but a cheaper one would fit', async () => {
    const res = await runPropose('propose.plan', { seconds: 30, options: [{ title: 'A', ratio: '16:9', resolution: '1080p', shots: [shot('a', 8), shot('b', 8), shot('a2', 7), shot('b2', 7)] }, { title: 'B', ratio: '16:9', resolution: '1080p', shots: [shot('c', 8), shot('d', 8), shot('c2', 7), shot('d2', 7)] }] }, ctx('home', {}, { balance: { plan: 800, purchased: 0, held: 0 } }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/every option costs more than the available 800 credits/);
  });
});

describe('suggestSplit', () => {
  it('finds whole-second splits that fit the model range', async () => {
    const { suggestSplit } = await import('../src/proposals');
    const seedance = { min: 4, max: 15 };
    expect(suggestSplit(6, [seedance], 2)).toEqual([6]);
    expect(suggestSplit(10, [seedance], 3)).toEqual([5, 5]);
    expect(suggestSplit(30, [seedance], 8)).toEqual([5, 5, 4, 4, 4, 4, 4]);
    expect(suggestSplit(6, [{ min: 2, max: 30 }], 3)).toEqual([2, 2, 2]);
    expect(suggestSplit(3, [seedance], 1)).toBeNull();
  });
});

describe('lenient plan input (what the live model gets wrong, fixed by the server instead of a retry)', () => {
  it('makes shot lengths add up when they are close, inside the model range and the pacing limit', async () => {
    const { fitShotSeconds } = await import('../src/proposals');
    const range = { min: 4, max: 15 };
    const s = (seconds: number, words = 0) => ({ seconds, words, range });
    expect(fitShotSeconds([s(5), s(5), s(5), s(5), s(5)], 30)).toEqual([6, 6, 6, 6, 6]);
    expect(fitShotSeconds([s(6), s(6), s(6), s(6), s(6)], 30)).toBeNull();
    expect(fitShotSeconds([s(7), s(7), s(6)], 15)).toEqual([5, 5, 5]);
    // Never below the model minimum, never more than 2 s per shot, never under what a spoken line needs.
    expect(fitShotSeconds([s(4), s(4)], 6)).toBeNull();
    expect(fitShotSeconds([s(5), s(5)], 20)).toBeNull();
    expect(fitShotSeconds([s(6, 18), s(6)], 9)).toBeNull();
    expect(fitShotSeconds([{ seconds: 4, words: 0, range: { min: 5, max: 8, allowed: [5, 8] } }], 8)).toBeNull();
    const res = await runPropose('propose.plan', { seconds: 30, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', shots: [1, 2, 3, 4, 5].map((n) => shot(`s${n}`, 5)) })) }, ctx('home'));
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.proposal.body as PlanBody).options[0]!.shots.map((x) => x.seconds)).toEqual([6, 6, 6, 6, 6]);
  });

  it('maps camera words outside the lists and drops the ones it cannot place', async () => {
    const { normalizeCamera } = await import('../src/proposals');
    const cam = (c: Record<string, unknown>) => (normalizeCamera(c), c);
    expect(cam({ size: 'over_the_shoulder', move: 'dolly_in' })).toEqual({ angle: 'over_the_shoulder', move: 'push_in' });
    expect(cam({ size: 'Two Shot', angle: 'top-down', move: 'whip' })).toEqual({ size: 'medium', angle: 'overhead' });
    expect(cam({ size: 'close_up', angle: 'eye_level', move: 'static', lens: '85mm' })).toEqual({ size: 'close_up', angle: 'eye_level', move: 'static', lens: '85mm' });
  });

  it('rebuilds a wrong closing tail of a stringified list, and says plainly when a list is still text', async () => {
    const { decodeJsonStrings } = await import('../src/proposals');
    expect(decodeJsonStrings({ options: '[{"a":[{"b":1}]}]}]' })).toEqual({ options: [{ a: [{ b: 1 }] }] });
    expect(decodeJsonStrings({ options: '[{"a":[{"b":"x]}"}]' })).toEqual({ options: [{ a: [{ b: 'x]}' }] }] });
    const res = await runPropose('propose.plan', { seconds: 6, options: '[{"title": "A", "shots": [{"title": }]' }, ctx('home'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/"options" must be a JSON array, not text/);
  });

  it('holds one option to a credit budget the brief names', async () => {
    const { budgetOf } = await import('../src/proposals');
    expect(budgetOf('Keep the whole thing under 600 credits.')).toBe(600);
    expect(budgetOf('max 1,200 credits please')).toBe(1200);
    expect(budgetOf('a 15 second ad')).toBeNull();
    const plan = { seconds: 15, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', shots: [shot('a', 5), shot('b', 5), shot('c', 5)] })) };
    const res = await runPropose('propose.plan', plan, { ...ctx('home'), userText: '15 second ad, keep it under 100 credits' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/the brief asks for at most 100 credits but the cheapest option costs \d+/);
  });

  it('D-005: every shot of an explicit brief from a mature-allowed member is checked against the mature lengths', async () => {
    const { matureSplit } = await import('../src/proposals');
    const c = ctx('home', {}, { matureAllowed: true });
    expect(matureSplit(10, c.ports.models)).toEqual({ n: 2, seconds: 5 });
    expect(matureSplit(8, c.ports.models)).toEqual({ n: 1, seconds: 8 });
    // The shots use no rule term themselves; the brief makes them mature clips.
    const plan = (seconds: number[]) => ({ seconds: 10, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', shots: seconds.map((s, i) => shot(`s${i}`, s)) })) });
    const bad = await runPropose('propose.plan', plan([4, 6]), { ...c, userText: 'A 10 second explicit sex scene between two fictional adults.' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/mature clips run on models that take 5 or 8 seconds, not 4.*could use 2 shots of 5 seconds/);
    const good = await runPropose('propose.plan', plan([5, 5]), { ...c, userText: 'A 10 second explicit sex scene between two fictional adults.' });
    expect(good.ok).toBe(true);
    if (good.ok) expect((good.proposal.body as PlanBody).options[0]!.shots.every((s) => s.mature)).toBe(true);
  });
});

describe('shot fields the composer can use', () => {
  const fields = (over: Record<string, unknown> = {}) => ({ title: 'A', seconds: 5, subject: 'Beans tumbling inside a drum roaster', action: 'The beans roll as the drum turns', ...over });
  const plan = (shotOver: Record<string, unknown> = {}, optionOver: Record<string, unknown> = {}) => ({
    seconds: 10,
    options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '16:9', model: 'bytedance/seedance-2.5', characters: [{ name: 'Roaster', look: 'man in his forties, short beard, no glasses', wardrobe: 'canvas apron, no jewelry' }], shots: [fields(shotOver), fields(shotOver)], ...optionOver })),
  });

  it('leaves out clauses that only say what is absent, and keeps a namesake noun out of the cast', async () => {
    const { dropNegatedClauses } = await import('../src/proposals');
    expect(dropNegatedClauses('seamless grey studio backdrop, no props')).toBe('seamless grey studio backdrop');
    expect(dropNegatedClauses('hard neon tubes, magenta and green, no fill')).toBe('hard neon tubes, magenta and green');
    expect(dropNegatedClauses('no props')).toBe('no props');
    expect(dropNegatedClauses('Wei answers without raising his voice')).toBe('Wei answers without raising his voice');
    const res = await runPropose('propose.plan', plan({ setting: 'roastery at sunrise, no people' }), ctx('home'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const option = (res.proposal.body as PlanBody).options[0]!;
    expect(option.characters).toEqual([{ name: 'Roaster', look: 'man in his forties, short beard', wardrobe: 'canvas apron' }]);
    expect(option.shots[0]!.shot).toMatchObject({ setting: 'roastery at sunrise' });
    // "a drum roaster" is the machine, not the man called Roaster.
    expect(option.shots[0]!.shot?.characters).toBeUndefined();
  });

  it('asks for English in the descriptive fields; speech and captions keep their language', async () => {
    const zh = await runPropose('propose.plan', plan({ subject: '小雨站在便利店门口' }), ctx('home'));
    expect(zh.ok).toBe(false);
    if (!zh.ok) expect(zh.error).toMatch(/write subject, action, setting, lighting, look and the characters' look in English/);
    const ok = await runPropose('propose.plan', plan({ line: '雨下了一整夜。', title: '雨夜' }), ctx('home'));
    expect(ok.ok, ok.ok ? '' : ok.error).toBe(true);
  });
});

describe('shots shorter than the model takes', () => {
  const short = (model: string | undefined, over: Record<string, unknown> = {}) => ({ seconds: 6, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '1:1', ...(model ? { model } : {}), shots: [0, 1].map((i) => ({ title: `s${i}`, seconds: 3, subject: 'A sneaker on a black floor', action: 'The sneaker lands and settles', ...over })) })) });

  it('moves the option to the cheapest listed model that takes the lengths, unless the user picked the model', async () => {
    const res = await runPropose('propose.plan', short('bytedance/seedance-2.5'), ctx('home'));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (res.ok) expect((res.proposal.body as PlanBody).options[0]!.shots.map((s) => `${s.model} ${s.seconds}`)).toEqual(['lumina/berry-1.0 3', 'lumina/berry-1.0 3']);
    const picked = await runPropose('propose.plan', short('bytedance/seedance-2.5'), { ...ctx('home'), settings: { videoModel: 'bytedance/seedance-2.5' } });
    expect(picked.ok).toBe(false);
    if (!picked.ok) expect(picked.error).toContain('from 4 to 15');
  });
});

describe('graph patches on planned shots', () => {
  it('leaves out an update that changes nothing a node would generate (a camera move sent to a keyframe)', async () => {
    const { shotGraph } = await import('../evals/world');
    const world = evalWorld({ canvas: 'shots' });
    const c = { ...ctx('canvas'), ports: evalPorts(world) };
    expect(shotGraph().nodes.some((n) => n.id === 'node_key1')).toBe(true);
    const res = await runPropose(
      'propose.graphPatch',
      { projectId: PROJECT_ID, baseRevision: 7, summary: 'Static camera', ops: ['node_key1', 'node_shot1'].map((nodeId) => ({ op: 'updateNode', nodeId, params: { shot: { camera: { move: 'static' } } } })) },
      c,
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect((res.proposal.body as GraphPatchBody).touched.updated).toEqual(['node_shot1']);
    const none = await runPropose('propose.graphPatch', { projectId: PROJECT_ID, baseRevision: 7, summary: 'x', ops: [{ op: 'updateNode', nodeId: 'node_key1', params: { shot: { camera: { move: 'static' } } } }] }, c);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/these ops change nothing/);
  });
});

describe('timeline: cut to a length', () => {
  it('plans the cut on the server from one cutTo op and stores the real ops', async () => {
    const c = ctx('editor');
    const res = await runPropose('propose.timelinePatch', { canvasId: CANVAS_ID, baseRevision: 3, summary: 'Cut to 10 s', ops: [{ op: 'cutTo', seconds: 10 }] }, c);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const body = res.proposal.body as TimelinePatchBody;
    expect(body.durationAfter).toBe(10);
    expect(body.ops.length).toBeGreaterThan(1);
    expect(body.ops.every((o) => (o.op as string) !== 'cutTo')).toBe(true);
    const longer = await runPropose('propose.timelinePatch', { canvasId: CANVAS_ID, baseRevision: 3, summary: 'x', ops: [{ op: 'cutTo', seconds: 40 }] }, c);
    expect(longer.ok).toBe(false);
    if (!longer.ok) expect(longer.error).toMatch(/cutTo 40: the cut is 15 s long/);
  });
});
