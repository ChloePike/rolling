/** Shots through run planning: a node planned from a structured shot is composed per model; an edited prompt is not. */
import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureModel } from '../models/__fixtures__/catalog';
import type { GraphEdge, GraphNode, GraphState } from '../graph/types';
import { computeInputDigests } from '../project/digest';
import { planRun as structuralPlan } from '../project/plan';
import { canonicalPrompt, type ShotSpec } from '../prompting/shot';
import { KEYFRAME_DIRECTION, planRun as planLayer } from './plan';
import { buildGenerateRequest } from './request';
import { planPromptSpec } from './specPlan';
import { PromptSpecSchema } from './spec';
import type { PlanContext, PlanItem } from './types';

const PLUS: PlanContext = { plan: 'plus', matureAllowed: false };
const MATURE: PlanContext = { plan: 'plus', matureAllowed: true };

const shot: ShotSpec = {
  subject: 'Maya holding a green glass bottle',
  action: 'Maya twists the cap off and smiles',
  setting: 'A riverside rock at dawn',
  camera: { size: 'medium', move: 'push_in' },
  lighting: 'Soft golden light',
  characters: [{ name: 'Maya', look: 'woman in her thirties, short black hair', wardrobe: 'denim jacket' }],
};

const node = (id: string, kind: GraphNode['kind'], params: Record<string, unknown>, title = id): GraphNode => ({ id, kind, title, params, position: { x: 0, y: 0 }, groupId: null, status: 'idle', createdBy: 'agent' });
const edge = (from: string, to: string, port: string): GraphEdge => ({ id: `e_${from}_${to}`, from: { node: from, port: 'out' }, to: { node: to, port } });

async function plan(graph: GraphState, ctx: PlanContext = PLUS): Promise<Record<string, PlanItem>> {
  const digests = computeInputDigests(graph, new Map());
  const structural = structuralPlan(graph, new Map(), digests, 'all', []);
  const out = await planLayer({ graph, structural, catalog: fixtureCatalog, ctx });
  return Object.fromEntries(out.items.map((i) => [i.ref, i]));
}

function canvas(over: { keyPrompt?: string; shotPrompt?: string } = {}): GraphState {
  return {
    revision: 1,
    groups: [],
    nodes: [
      node('script', 'script', { rows: [{ n: '01', title: 'Hero', visual: 'ROW ONE TEXT', seconds: 5 }, { n: '02', title: 'End', visual: 'ROW TWO TEXT', seconds: 5 }] }),
      node('sheet', 'image', { prompt: 'Maya, full body', model: 'bytedance/seedream-5.0-lite', ratio: '3:4' }, 'Character: Maya'),
      node('key', 'image', { prompt: over.keyPrompt ?? canonicalPrompt(shot, 'still'), shot, model: 'bytedance/seedream-5.0-lite', mode: 'edit', ratio: '9:16' }),
      node('vid', 'video', { prompt: over.shotPrompt ?? canonicalPrompt(shot), shot, model: 'bytedance/seedance-2.5', mode: 'i2v', seconds: 5, ratio: '9:16', resolution: '720p' }),
    ],
    edges: [edge('script', 'key', 'prompt'), edge('sheet', 'key', 'refs'), edge('key', 'vid', 'frame')],
  };
}

describe('shots in run planning', () => {
  it('a shot node keeps its own row: the script text is not repeated in its prompt', async () => {
    const items = await plan(canvas());
    expect(items.key!.spec).toMatchObject({ mode: 'edit', prompt: canonicalPrompt(shot, 'still'), shot });
    expect(items.key!.spec!.prompt).not.toContain('ROW TWO TEXT');
    expect(items.key!.spec!.inputs).toEqual([{ role: 'edit', media: 'image', from: { node: 'sheet' }, label: 'Character: Maya' }]);
    expect(items.vid!.spec).toMatchObject({ mode: 'i2v', prompt: canonicalPrompt(shot), shot });
  });

  it('the provider prompt is written for the model: the keyframe binds its reference, the clip is motion and camera', async () => {
    const items = await plan(canvas());
    const key = buildGenerateRequest(items.key!.spec!, fixtureModel('bytedance/seedream-5.0-lite'), [{ input: items.key!.spec!.inputs[0]!, url: 'https://m.example/sheet.png', origin: 'generated' }]);
    expect(key.promptComposed).toBe(true);
    expect(key.prompt.startsWith('Image 1 is the character Maya: keep the face, hair and outfit identical.')).toBe(true);
    const vid = buildGenerateRequest(items.vid!.spec!, fixtureModel('bytedance/seedance-2.5'), [{ input: items.vid!.spec!.inputs[0]!, url: 'https://m.example/key.png', origin: 'generated' }]);
    expect(vid.prompt).toBe('Keep the subject, look and setting of the first frame. Maya twists the cap off and smiles. In the shot: Maya. The camera slowly pushes in. No subtitles.');
    expect(vid.firstFrameUrl).toBe('https://m.example/key.png');
  });

  it('an edited prompt is the user’s text: no shot, sent as typed, script text as before', async () => {
    const items = await plan(canvas({ shotPrompt: 'my own words 我的提示词', keyPrompt: 'hand-written keyframe' }));
    expect(items.vid!.spec!.shot).toBeUndefined();
    expect(items.vid!.spec!.prompt).toBe('my own words 我的提示词');
    expect(items.key!.spec!.shot).toBeUndefined();
    expect(items.key!.spec!.prompt).toContain('ROW TWO TEXT');
    expect(items.key!.spec!.inputs[0]).not.toHaveProperty('label');
    const req = buildGenerateRequest(items.vid!.spec!, fixtureModel('bytedance/seedance-2.5'), []);
    expect(req.prompt).toBe('my own words 我的提示词');
    expect(req.promptComposed).toBeUndefined();
  });

  it('a text node wired into a shot node makes the prompt the user’s assembly', async () => {
    const g = canvas();
    g.nodes.push(node('note', 'text', { text: 'Extra direction from the user.' }));
    g.edges.push(edge('note', 'vid', 'prompt'));
    const items = await plan(g);
    expect(items.vid!.spec!.shot).toBeUndefined();
    expect(items.vid!.spec!.prompt).toContain('Extra direction from the user.');
  });

  it('mature chain: a shot keyframe is its still, the animation is motion only; typed text keeps the still direction', async () => {
    const explicit: ShotSpec = { subject: 'Two adults in a dim bedroom', action: 'They undress each other, explicit sex scene', setting: 'A hotel room at night', camera: { size: 'medium', move: 'static' } };
    const g: GraphState = { revision: 1, groups: [], edges: [], nodes: [node('vid', 'video', { prompt: canonicalPrompt(explicit), shot: explicit, model: 'auto', seconds: 5, ratio: '16:9' })] };
    const items = await plan(g, MATURE);
    const kf = items['vid:keyframe']!;
    expect(kf.spec).toMatchObject({ kind: 'image', mature: true, chain: { step: 'keyframe' }, shot: explicit });
    expect(kf.spec!.prompt).toBe(canonicalPrompt(explicit, 'still'));
    expect(kf.spec!.prompt).not.toContain(KEYFRAME_DIRECTION);
    const anim = items.vid!;
    expect(anim.spec).toMatchObject({ mode: 'i2v', mature: true, chain: { step: 'animate' }, shot: explicit });
    const model = fixtureCatalog.get(anim.spec!.modelId)!;
    const req = buildGenerateRequest(anim.spec!, model, [{ input: anim.spec!.inputs[0]!, url: 'https://m.example/k.png', origin: 'generated' }]);
    expect(req.prompt).toBe('They undress each other, explicit sex scene. The camera stays still.');
    expect(req.mature).toBe(true);

    // The same run from typed text is unchanged: still direction + the user's words, then the user's words.
    const typed = await planPromptSpec({ spec: PromptSpecSchema.parse({ kind: 'video', prompt: 'two adults, explicit sex scene in a hotel room', seconds: 5 }), assetOrigins: new Map(), catalog: fixtureCatalog, ctx: MATURE });
    const byRef = Object.fromEntries(typed.items.map((i) => [i.ref, i]));
    expect(byRef.keyframe!.spec!.prompt).toBe(`${KEYFRAME_DIRECTION} two adults, explicit sex scene in a hotel room`);
    expect(byRef.spec!.spec!.prompt).toBe('two adults, explicit sex scene in a hotel room');
    expect(byRef.spec!.spec!.shot).toBeUndefined();
  });

  it('one rewrite, not two: the gateway expands a typed prompt, never one composed from a shot (D-020)', async () => {
    const expanding = { ...PLUS, promptExpand: { default: true, available: true } };
    const model = fixtureCatalog.models.find((m) => m.kind === 'video' && m.params.promptExpand && m.operations.includes('t2v'))!;
    const typed: GraphState = { revision: 1, groups: [], edges: [], nodes: [{ ...node('vid', 'video', { prompt: 'a red fox in the snow', model: model.id, seconds: 5, promptExpand: true }), createdBy: 'user' }] };
    const t = (await plan(typed, expanding)).vid!;
    expect(t.spec!.promptExpand).toBeDefined();
    const sent = buildGenerateRequest(t.spec!, model, []);
    expect(sent.prompt).toBe('a red fox in the snow');
    expect(sent.promptExpand).toBeDefined();
    expect(sent.promptComposed).toBeUndefined();

    // A shot node with the toggle forced on: composed for the model, not expanded and not priced for expansion.
    const g: GraphState = { revision: 1, groups: [], edges: [], nodes: [node('vid', 'video', { prompt: canonicalPrompt(shot), shot, model: model.id, seconds: 5, promptExpand: true })] };
    const s = (await plan(g, expanding)).vid!;
    expect(s.spec!.shot).toEqual(shot);
    expect(s.spec!.promptExpand).toBeUndefined();
    expect(s.priceRequest).not.toHaveProperty('promptExpandUsd');
    const composed = buildGenerateRequest({ ...s.spec!, promptExpand: t.spec!.promptExpand! }, model, []);
    expect(composed.promptComposed).toBe(true);
    expect(composed.promptExpand).toBeUndefined();
  });
});
