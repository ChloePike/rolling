/**
 * Shared fixtures for tests and evals: the real catalog fixture (GET /v1/models,
 * 2026-11-25), a sample canvas and a sample timeline.
 */
import { fixtureCatalog } from '@rolling/core/models/__fixtures__/catalog';
import type { ChatEvent, LlmProvider } from '@rolling/core';
import { canonicalPrompt, characterSheetShot, type ShotCharacter, type ShotSpec } from '@rolling/core/prompting';
import { createSafetyGate, type SafetyGate } from '@rolling/core/safety';
import type { GraphState } from '@rolling/core/graph';
import { assembleFromScript, type Edl } from '@rolling/core/timeline';
import { account, memoryPorts, memoryWorld, type MemoryWorld } from '../src/testkit';
import type { AccountSnapshot, AssetItem } from '../src/ports';

export const catalog = fixtureCatalog;

export const PROJECT_ID = 'prj_01JDEVALPROJECT000000000';
export const CANVAS_ID = 'cnv_01JDEVALPROJECT000000000';

export const PRODUCT_PHOTO: AssetItem = {
  id: 'ast_01JDEVALPRODUCTPHOTO0000',
  name: 'Ridgeline bottle.png',
  kind: 'image',
  source: 'mine',
  description: 'Green glass bottle of sparkling water with a white mountain label',
};
export const LOGO: AssetItem = { id: 'ast_01JDEVALLOGO000000000000', name: 'Logo.png', kind: 'image', source: 'mine', description: 'Brand logo, white on transparent' };
export const POSE: AssetItem = { id: 'ast_01JDEVALPOSE000000000000', name: 'Standing pose 12', kind: 'image', source: 'public', license: 'first-party', description: 'Standing, hands on hips' };

/** A canvas like the golden path after "Build on canvas": script, keyframe and two shots. */
export function sampleGraph(revision = 7, withShot3 = false): GraphState {
  const n = (id: string, kind: GraphState['nodes'][number]['kind'], title: string, params: Record<string, unknown>, x: number, y: number, by: 'agent' | 'user' = 'agent') => ({
    id,
    kind,
    title,
    params,
    position: { x, y },
    groupId: null,
    status: 'idle' as const,
    createdBy: by,
  });
  return {
    revision,
    nodes: [
      n('node_script', 'script', 'Ridgeline Sparkling', { rows: [{ n: '01', title: 'Hero', visual: 'Bottle on a riverside rock at dawn', seconds: 5 }, { n: '02', title: 'Cap pop', visual: 'Hand twists the cap, bubbles rise', seconds: 5 }] }, 96, 96),
      n('node_photo', 'asset', 'Ridgeline bottle.png', { media: 'image', assetId: PRODUCT_PHOTO.id }, 96, 356, 'user'),
      n('node_key1', 'image', 'Keyframe 1', { prompt: 'Green bottle on a riverside rock, dawn light', model: 'bytedance/seedream-5.0-lite', mode: 'edit', ratio: '9:16', count: 1 }, 436, 96),
      n('node_shot1', 'video', 'Shot 1: Hero', { prompt: 'Slow push-in on the bottle on a riverside rock, dawn light', model: 'bytedance/seedance-2.5', mode: 'i2v', seconds: 5, resolution: '720p', ratio: '9:16' }, 776, 96),
      n('node_shot2', 'video', 'Shot 2: Cap pop', { prompt: 'Close-up, a hand twists the cap, bubbles rising, cool morning light', model: 'bytedance/seedance-2.5', mode: 't2v', seconds: 5, resolution: '720p', ratio: '9:16' }, 776, 356),
      ...(withShot3
        ? [n('node_shot3', 'video', 'Shot 3: Logo', { prompt: 'Bottle centered on the rock, room for the tagline', model: 'bytedance/seedance-2.5', mode: 't2v', seconds: 5, resolution: '720p', ratio: '9:16' }, 776, 616)]
        : []),
    ],
    edges: [
      { id: 'edge_1', from: { node: 'node_script', port: 'out' }, to: { node: 'node_key1', port: 'prompt' } },
      { id: 'edge_2', from: { node: 'node_photo', port: 'out' }, to: { node: 'node_key1', port: 'refs' } },
      { id: 'edge_3', from: { node: 'node_key1', port: 'out' }, to: { node: 'node_shot1', port: 'frame' } },
    ],
    groups: [],
  };
}

export const MAYA: ShotCharacter = { name: 'Maya', look: 'woman in her thirties, short black hair, light freckles', wardrobe: 'denim jacket over a white tee' };
const LOOK = 'Clean commercial look, cool greens and warm skin tones';

export const SHOT_1: ShotSpec = {
  subject: 'Maya sitting on a riverside rock with a green glass bottle of sparkling water beside her',
  action: 'Maya looks over the river and picks up the bottle',
  setting: 'A mountain river at dawn, mist over the water',
  camera: { size: 'wide', angle: 'eye_level', move: 'push_in' },
  lighting: 'Cool blue dawn light with a first warm rim from the left',
  style: LOOK,
  characters: [MAYA],
};
export const SHOT_2: ShotSpec = {
  subject: "Maya's hands holding the green glass bottle",
  action: 'Maya twists the cap off and a burst of bubbles rises',
  setting: 'The same riverside rock at dawn',
  camera: { size: 'close_up', angle: 'eye_level', move: 'static' },
  lighting: 'Cool morning light from the left',
  style: LOOK,
  characters: [MAYA],
};

/** A canvas as "Build on canvas" makes it from structured shots: script, a character sheet, keyframes and two shots. */
export function shotGraph(revision = 7): GraphState {
  const n = (id: string, kind: GraphState['nodes'][number]['kind'], title: string, params: Record<string, unknown>, x: number, y: number) => ({
    id,
    kind,
    title,
    params,
    position: { x, y },
    groupId: null,
    status: 'idle' as const,
    createdBy: 'agent' as const,
  });
  const sheet = characterSheetShot(MAYA, LOOK);
  const video = (shot: ShotSpec) => ({ prompt: canonicalPrompt(shot), shot, model: 'bytedance/seedance-2.5', mode: 'i2v', seconds: 5, resolution: '720p', ratio: '9:16' });
  const key = (shot: ShotSpec) => ({ prompt: canonicalPrompt(shot, 'still'), shot, model: 'bytedance/seedream-5.0-lite', mode: 'edit', ratio: '9:16', count: 1 });
  return {
    revision,
    nodes: [
      n('node_script', 'script', 'Ridgeline Sparkling', { rows: [{ n: '01', title: 'Hero', visual: canonicalPrompt(SHOT_1), seconds: 5 }, { n: '02', title: 'Cap pop', visual: canonicalPrompt(SHOT_2), seconds: 5 }], ratio: '9:16' }, 96, 96),
      n('node_char1', 'image', 'Character: Maya', { prompt: canonicalPrompt(sheet, 'still'), shot: sheet, model: 'bytedance/seedream-5.0-lite', mode: 't2i', ratio: '3:4', count: 1 }, 96, 356),
      n('node_key1', 'image', 'Keyframe 1: Hero', key(SHOT_1), 436, 96),
      n('node_key2', 'image', 'Keyframe 2: Cap pop', key(SHOT_2), 436, 356),
      n('node_shot1', 'video', 'Shot 1: Hero', video(SHOT_1), 776, 96),
      n('node_shot2', 'video', 'Shot 2: Cap pop', video(SHOT_2), 776, 356),
    ],
    edges: [
      { id: 'edge_1', from: { node: 'node_script', port: 'out' }, to: { node: 'node_key1', port: 'prompt' } },
      { id: 'edge_2', from: { node: 'node_char1', port: 'out' }, to: { node: 'node_key1', port: 'refs' } },
      { id: 'edge_3', from: { node: 'node_key1', port: 'out' }, to: { node: 'node_shot1', port: 'frame' } },
      { id: 'edge_4', from: { node: 'node_script', port: 'out' }, to: { node: 'node_key2', port: 'prompt' } },
      { id: 'edge_5', from: { node: 'node_char1', port: 'out' }, to: { node: 'node_key2', port: 'refs' } },
      { id: 'edge_6', from: { node: 'node_key2', port: 'out' }, to: { node: 'node_shot2', port: 'frame' } },
    ],
    groups: [],
  };
}

/** The canvas a case starts from. */
export function graphForCanvas(canvas: 'legacy' | 'shots' | undefined, withShot3 = false): GraphState {
  return canvas === 'shots' ? shotGraph() : sampleGraph(7, withShot3);
}

/** Classifier stand-in for offline runs: every text is rated safe, so only the deterministic D-005 rules decide. */
const rulesOnlyLlm: LlmProvider = {
  id: 'rules-only',
  async *chat(): AsyncIterable<ChatEvent> {
    yield {
      type: 'text',
      delta: JSON.stringify({ sexualLevel: 'none', apparentMinor: false, minorSexualized: false, realPerson: false, realPersonNames: [], realPersonSexualOrIntimate: false, nonConsensualSexual: false, animalSexual: false, extremeViolence: false, violentExtremism: false, selfHarm: false }),
    };
  },
};

/**
 * The real safety gate with the deterministic rules and a classifier that
 * rates everything safe: offline evals exercise the gate's hard-limit rules
 * and the mature-required path without a model call. The classifier's own
 * judgement needs a live run.
 */
export function rulesOnlyGate(): SafetyGate {
  let n = 0;
  return createSafetyGate({ llm: rulesOnlyLlm, chatModels: catalog.models.filter((m) => m.kind === 'chat'), newKey: () => `eval_safety_${++n}` });
}

/** A 3-shot cut of 15 s with captions, a voiceover and music (editor golden path). */
export function sampleEdl(shotSeconds: number[] = [5, 5, 5]): Edl {
  const total = shotSeconds.reduce((a, b) => a + b, 0);
  return assembleFromScript({
    fps: 30,
    width: 1080,
    height: 1920,
    shots: shotSeconds.map((s, i) => ({
      nodeId: `node_shot${i + 1}`,
      assetId: `ast_shot${i + 1}`,
      seconds: s,
      caption: { text: ['The first sip of the mountains.', 'Pop it open and taste the cold.', 'Ridgeline Sparkling. Find your ridge.', 'Made with spring water.'][i % 4]!, at: 0.5, dur: s - 1 },
    })),
    voiceover: { assetId: 'ast_voice', seconds: total - 2, at: 0.5 },
    music: { assetId: 'ast_music', seconds: total, gainDb: -12 },
  });
}

export function evalWorld(overrides: { account?: Partial<AccountSnapshot>; edl?: Edl; graph?: GraphState; editor?: boolean; canvas?: 'legacy' | 'shots' } = {}): MemoryWorld {
  const world = memoryWorld({
    assets: [PRODUCT_PHOTO, LOGO, POSE, { id: 'ast_01JDEVALMUSIC00000000000', name: 'Morning drive.mp3', kind: 'audio', source: 'builtin', license: 'first-party' }],
    characters: [{ id: 'chr_01JDEVALMAYA000000000000', name: 'Maya', description: 'Woman in her thirties, short black hair, denim jacket' }],
    voices: [{ id: 'voc_01JDEVALCLEARF0000000000', name: 'Clear female', description: 'Warm, mid-pitch, English' }],
    templates: [{ id: 'tpl_01JDEVALPRODUCTAD0000000', name: 'Product ad 15s', description: '3 shots, hook, product, logo', slots: ['product photo', 'tagline'] }],
    account: account(overrides.account),
  });
  world.graphs.set(PROJECT_ID, { state: overrides.graph ?? graphForCanvas(overrides.canvas, overrides.editor ?? false), assets: {} });
  world.timelines.set(CANVAS_ID, { revision: 3, edl: overrides.edl ?? sampleEdl() });
  return world;
}

export function evalPorts(world: MemoryWorld) {
  return { ...memoryPorts(world, catalog), safety: rulesOnlyGate() };
}
