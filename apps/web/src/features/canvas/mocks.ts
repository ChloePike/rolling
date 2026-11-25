import type { GraphState } from '@rolling/core/graph';

/**
 * Mock project shaped like the ProjectRoom snapshot, with the values of
 * Canvas.dc.html so the screen can be compared pixel for pixel.
 * Thumbnails are not generated yet, so `tone` stands in for them.
 */

export const MOCK_PROJECT_ID = 'prj_demo';

export const NODE = {
  script: 'node_01JDCANVAS0SCR1PT000000000',
  photo: 'node_01JDCANVAS0PH0T0000000000',
  voice: 'node_01JDCANVAS0V01CE000000000',
  keyframe: 'node_01JDCANVAS0KEYFRAME00000',
  shotA: 'node_01JDCANVAS0SH0TA000000000',
  shotB: 'node_01JDCANVAS0SH0TB000000000',
} as const;

/** One reference attached to a prompt: a chip with its source. */
export interface PromptRef {
  id: string;
  name: string;
  source: 'Mine' | 'Team' | 'Built-in' | 'Public';
  tone: string;
  letter: string;
}

export const MOCK_REFS: Record<string, PromptRef> = {
  m1: { id: 'm1', name: 'Product photo', source: 'Mine', tone: 'var(--c-tone-plum)', letter: '' },
  c1: { id: 'c1', name: 'Mia', source: 'Mine', tone: 'var(--c-tone-indigo)', letter: 'M' },
};

export const VOICE_WAVE = [8, 14, 20, 12, 24, 18, 10, 22, 26, 16, 12, 20, 26, 14, 10, 18, 24, 12, 8, 16, 22, 14, 20, 10, 18, 24, 12, 8];

export interface ScriptRow {
  n: string;
  scene: string;
  visual: string;
  line: string;
  cast: string[];
  seconds: number;
  status: 'done' | 'generating' | 'pending' | 'off';
  selected: boolean;
}

export const SCRIPT_ROWS: ScriptRow[] = [
  { n: '01', scene: 'Riverside · Dawn', visual: 'Bottle on a rock, morning light from the left, slow push-in', line: '', cast: [], seconds: 4, status: 'done', selected: true },
  { n: '02', scene: 'Riverside · Dawn', visual: 'Hand twists the cap, close-up of bubbles rising', line: '“Pop it open.”', cast: ['Lead'], seconds: 5, status: 'generating', selected: true },
  { n: '03', scene: 'Riverside · Dawn', visual: 'Bottle centered, tagline comes in', line: '“The first sip of the mountains.”', cast: [], seconds: 3, status: 'pending', selected: true },
  { n: '04', scene: 'Forest · Noon', visual: 'Lead sits on a rock, takes a sip, looks into the distance', line: '', cast: ['Lead'], seconds: 4, status: 'off', selected: false },
];

/** Shot rows shown in the script node on the canvas. */
const SCRIPT_NODE_ROWS = [
  { n: '01', visual: 'Bottle on a riverside rock, dawn light', seconds: 4 },
  { n: '02', visual: 'Hand twists the cap, close-up of bubbles rising', seconds: 5 },
];

export function mockGraph(): GraphState {
  return {
    revision: 42,
    nodes: [
      {
        id: NODE.script,
        kind: 'script',
        title: 'Ridgeline Sparkling',
        params: { rows: SCRIPT_NODE_ROWS, versionLabel: 'v2' },
        position: { x: 96, y: 96 },
        groupId: null,
        status: 'done',
        createdBy: 'agent',
      },
      {
        id: NODE.photo,
        kind: 'asset',
        title: 'Product photo.png',
        params: { media: 'image', label: 'Product reference', tone: 'var(--c-tone-teal)' },
        position: { x: 96, y: 360 },
        groupId: null,
        status: 'done',
        createdBy: 'user',
      },
      {
        id: NODE.voice,
        kind: 'audio',
        title: 'Voiceover',
        params: { voice: 'Clear female', seconds: 8, runCost: 2, wave: VOICE_WAVE, text: 'Morning. The first sip of the mountains. Pop it open.' },
        position: { x: 96, y: 636 },
        groupId: null,
        status: 'idle',
        createdBy: 'agent',
      },
      {
        id: NODE.keyframe,
        kind: 'image',
        title: 'Product keyframe',
        params: {
          tone: 'var(--c-tone-plum)',
          prompt: 'Place the @[Product photo] bottle on a riverside rock, early side light, soft-focus forest behind',
          model: 'Seedream 5.0 Pro',
          mode: 'Image to image',
          ratio: '9:16',
          resolution: '2K',
          count: 2,
          quick: ['Style', 'Framing', 'Lighting', 'Camera'],
          refs: ['m1'],
          runCost: 2,
        },
        position: { x: 448, y: 96 },
        groupId: null,
        status: 'done',
        version: { n: 2, total: 2 },
        createdBy: 'agent',
      },
      {
        id: NODE.shotA,
        kind: 'video',
        title: 'Shot A: Hero shot',
        params: {
          tone: 'var(--c-tone-indigo)',
          seconds: 4,
          prompt:
            'Start from @[Product keyframe], morning light from the left, slow push-in from a medium shot to a close-up of the bottle, small glints on the water',
          model: 'Seedance 2.5',
          mode: 'First frame',
          ratio: '9:16',
          resolution: '720p',
          length: 5,
          extra: '×1 · Audio on',
          quick: ['Style', 'Camera', 'Lighting', 'Pace'],
          refs: ['m1', 'c1'],
          runCost: 8,
        },
        position: { x: 772, y: 96 },
        groupId: null,
        status: 'outdated',
        version: { n: 1, total: 1 },
        createdBy: 'agent',
      },
      {
        id: NODE.shotB,
        kind: 'video',
        title: 'Shot B: Cap pop',
        params: { tone: 'var(--c-tone-indigo)', seconds: 5, prompt: 'Hand twists the cap, close-up of bubbles rising', model: 'Seedance 2.5', mode: 'First frame', ratio: '9:16',
          resolution: '720p',
          length: 5, extra: '×1 · Audio on', quick: ['Style', 'Camera', 'Lighting', 'Pace'], refs: ['m1'], runCost: 8 },
        position: { x: 772, y: 616 },
        groupId: null,
        status: 'generating',
        progress: 0.58,
        createdBy: 'agent',
      },
    ],
    edges: [
      { id: 'edge_01JDCANVAS0E1000000000000', from: { node: NODE.script, port: 'out' }, to: { node: NODE.keyframe, port: 'prompt' } },
      { id: 'edge_01JDCANVAS0E2000000000000', from: { node: NODE.photo, port: 'out' }, to: { node: NODE.keyframe, port: 'refs' } },
      { id: 'edge_01JDCANVAS0E3000000000000', from: { node: NODE.keyframe, port: 'out' }, to: { node: NODE.shotA, port: 'frame' } },
      { id: 'edge_01JDCANVAS0E4000000000000', from: { node: NODE.keyframe, port: 'out' }, to: { node: NODE.shotB, port: 'frame' } },
      { id: 'edge_01JDCANVAS0E5000000000000', from: { node: NODE.voice, port: 'out' }, to: { node: NODE.shotB, port: 'audio' } },
    ],
    groups: [],
  };
}

export const MOCK_PROJECT = { id: MOCK_PROJECT_ID, title: 'Ridgeline Sparkling · 15s ad' };

/** Agent thread on the canvas (surface `canvas`, skill `tv-ad`). */
export const MOCK_AGENT = {
  skill: '/TV ad',
  messages: [
    { role: 'user' as const, text: 'A 15-second vertical ad for Ridgeline Sparkling Water. Open on a close-up of the cap popping, end on the logo.' },
    { role: 'agent' as const, text: 'I split this into 3 shots: keyframes first, then video. Nodes go on the canvas only after you approve the plan, and nothing is charged until then.' },
  ],
  plan: {
    id: 'prop_01JDCANVASPLAN0000000000',
    title: 'Option A · Riverside at dawn',
    // Seedance 2.5 at 720p (4s + 5s + 3s) plus three Seedream keyframes, D-006 credits.
    estimate: 866,
    shots: [
      { n: 1, title: 'Hero shot', seconds: 4, visual: 'Riverside rock, push-in at dawn', tone: 'var(--c-saved)' },
      { n: 2, title: 'Cap pop', seconds: 5, visual: 'Hand close-up, bubbles rising', tone: 'var(--c-generating)' },
      { n: 3, title: 'Logo', seconds: 3, visual: 'Bottle centered, tagline comes in', tone: 'var(--c-text-3)' },
    ],
  },
};

export const MOCK_CREDITS = {
  balance: 2480,
  plan: 1800,
  purchased: 680,
  planExpires: new Date(2026, 10, 30),
  usedThisMonth: 1284,
  held: 16,
  expiringThisMonth: 300,
};

export const MOCK_SHARE = {
  url: 'studio.aigc.hub/s/7Kq2-mXa9',
  snapshotAt: new Date(2026, 10, 24, 11, 42),
};

/** Run history for the activity drawer (shape of `GET /api/runs` rows). */
export const MOCK_RUNS = [
  { id: 'run_01JDCANVASRUN00000000001', nodeId: NODE.shotB, title: 'Shot B: Cap pop', model: 'Seedance 2.5', credits: 8, status: 'running' as const, at: new Date(2026, 10, 25, 10, 12) },
  { id: 'run_01JDCANVASRUN00000000002', nodeId: NODE.keyframe, title: 'Product keyframe', model: 'Seedream 5.0 Pro', credits: 2, status: 'done' as const, at: new Date(2026, 10, 25, 10, 4) },
  { id: 'run_01JDCANVASRUN00000000003', nodeId: NODE.shotA, title: 'Shot A: Hero shot', model: 'Seedance 2.5', credits: 8, status: 'done' as const, at: new Date(2026, 10, 25, 9, 58) },
];
