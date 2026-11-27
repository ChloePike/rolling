import type { FeedItem } from '../types';

/** Mock data for Characters, matching Character.dc.html. */
/** The design's sample character: measurements and chip choices. */
export const characterSample = { age: '28', height: '168', pick: { hair: 'sideBob', body: 'balanced', wear: 'cityCasual', style: 'photoreal' } };

/** The design's Advanced "Model" short list (catalog ids). */
export const characterSegIds = ['bytedance/seedream-5.5', 'qwen/qwen-image-2.0'];
export const characterSettings = { resolution: '2K' };

/** Mock-mode estimate shown where real mode shows the server's quote. */
export function characterMockCost(o: { adv: boolean; res: string }): number {
  const res: Record<string, number> = { '1K': 2, '2K': 4, '4K': 8 };
  return o.adv ? (res[o.res] ?? 4) : 4;
}

export const characterPrompt = 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling.';

const ACTS = ['redo', 'sliders', 'save', 'down', 'star'] as const;
const pair = (a: string, b: string) => [
  { label: 'Full body', tone: a },
  { label: 'Face', tone: b },
];

export const characterFeed: FeedItem[] = [
  {
    kind: 'media', id: 'run_c1', aspect: '2/3', tiles: pair('var(--c-tone-blank)', 'var(--c-tone-blank)'), video: false, progress: 71,
    prompt: characterPrompt, tags: ['28 y/o', '168 cm', 'Side-part bob', 'Balanced', 'City casual', 'Photoreal'],
    steps: [
      { label: 'Build description', state: 'done' },
      { label: 'Seedream 5.0 Pro', state: 'done' },
      { label: 'Generating 71%', state: 'now' },
      { label: 'Consistency check', state: 'todo' },
    ],
    actions: [...ACTS],
  },
  {
    kind: 'media', id: 'run_c2', aspect: '2/3', tiles: pair('var(--c-tone-moss)', 'var(--c-tone-sage)'), video: false,
    prompt: 'Natural features, calm expression. Slightly upturned eyes, dimples when smiling',
    tags: ['28 y/o', '168 cm', 'Side-part bob', 'City casual', 'Photoreal'], finishedAgoMin: 15, actions: [...ACTS],
  },
  {
    kind: 'media', id: 'run_c3', aspect: '2/3', tiles: pair('var(--c-tone-plum)', 'var(--c-tone-mauve)'), video: false,
    prompt: 'Youthful, short hair, bright expression', tags: ['19 y/o', 'Short crop', 'Athleisure', 'Anime'], finishedAgoMin: 24 * 60, actions: [...ACTS],
  },
];

/** Mock-mode character page (`GET /api/characters/:id`, D-032): the sample character with its sheet, versions and checks. */
const view = (view: string, n: number) => ({ view, assetId: `ast_mock_${view}_${n}`, url: null, thumbUrl: null });
const SHEET = ['full_body', 'front', 'three_quarter', 'profile', 'expression_smile', 'expression_serious'];
export function characterDetailMock(id: string) {
  const now = Date.now();
  return {
    id,
    name: 'Mia',
    kind: 'person',
    meta: {},
    coverAssetId: 'ast_mock_front_2',
    coverUrl: null,
    descriptor: { kind: 'person', face: 'Woman in her late twenties, oval face, calm expression, dimples when smiling', hair: 'Side-part bob, black', build: 'Balanced, 168 cm', outfit: 'City casual: beige trench, white tee', style: 'Photoreal' },
    descriptorVersion: 2,
    sheet: SHEET.map((v) => view(v, 2)),
    outfits: [{ id: 'out_office', name: 'Office', outfit: 'Navy suit, white shirt', createdAt: now - 3600_000, views: [view('full_body', 9), view('three_quarter', 9)] }],
    realFace: false,
    drift: { checks: 4, scored: 4, mean: 0.81, min: 0.48, drifted: 1, verdict: 'drift' },
    projects: 2,
    createdAt: now - 3 * 86400_000,
    createdBy: null,
    versions: [
      { n: 2, descriptorVersion: 2, descriptor: null, createdAt: now - 86400_000, current: true, views: SHEET.map((v) => view(v, 2)), drift: { checks: 4, scored: 4, mean: 0.81, min: 0.48, drifted: 1, verdict: 'drift' } },
      { n: 1, descriptorVersion: 1, descriptor: null, createdAt: now - 3 * 86400_000, current: false, views: SHEET.slice(0, 4).map((v) => view(v, 1)), drift: { checks: 2, scored: 2, mean: 0.88, min: 0.86, drifted: 0, verdict: 'consistent' } },
    ],
    usedIn: [
      { projectId: 'prj_01', title: 'Morning coffee · Ep. 1', uses: 5, lastUsedAt: now - 7200_000 },
      { projectId: 'prj_02', title: 'Office drama · Ep. 2', uses: 2, lastUsedAt: now - 86400_000 },
    ],
    checks: [
      { id: 'chk_1', version: 2, assetId: 'ast_mock_out_1', projectId: 'prj_01', score: 0.48, verdict: 'drift', faces: 1, createdAt: now - 7200_000, thumbUrl: null },
      { id: 'chk_2', version: 2, assetId: 'ast_mock_out_2', projectId: 'prj_01', score: 0.86, verdict: 'consistent', faces: 1, createdAt: now - 9000_000, thumbUrl: null },
    ],
    training: { available: false, appliesLoras: ['lumina/w2.2-i2v-lora'] },
  };
}
