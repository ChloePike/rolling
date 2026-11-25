/**
 * Golden eval cases (docs/harness.md section 8). Expected properties, not
 * exact outputs. 40 briefs across skills (TV ad, product showcase,
 * storyboard, comic, brand kit, talking head, character), the canvas patch
 * cases from the golden path (docs/canvas-flow.md step 9) and the timeline
 * edit cases (section 8 and step 10).
 */
import type { AccountSnapshot } from '../src/ports';
import type { FieldTool } from '../src/tools/schemas';
import type { SkillId, Surface } from '../src/types';
import { LOGO, PRODUCT_PHOTO } from './world';

interface Base {
  id: string;
  brief: string;
  surface: Surface;
  skill?: SkillId;
  refs?: string[];
  selection?: string[];
  account?: Partial<AccountSnapshot>;
  /** Part of docs/canvas-flow.md (golden path). */
  golden?: boolean;
}

export interface PlanCase extends Base {
  kind: 'plan';
  expect: {
    shots: [number, number];
    /** Target length in seconds; every option within ±10%. */
    seconds?: number;
    ratio?: string;
    /** Balance hint: the cheapest option must cost at most this. */
    maxCredits?: number;
  };
}

export interface FieldsCase extends Base {
  kind: 'fields';
  expect: { tool: FieldTool; keepWords: string[] };
}

export interface GraphCase extends Base {
  kind: 'graphPatch';
  expect: { touch: string[]; onlyTouch?: boolean; params?: string[]; addKinds?: string[] };
}

export interface TimelineCase extends Base {
  kind: 'timeline';
  edit: 'cutTo' | 'swap' | 'lowerMusic' | 'shorterCaptions' | 'removeShot' | 'louderVoice';
  expect: { duration?: number; swap?: [string, string]; removed?: string };
}

export type EvalCase = PlanCase | FieldsCase | GraphCase | TimelineCase;

const ad = (id: string, brief: string, e: PlanCase['expect'], extra: Partial<PlanCase> = {}): PlanCase => ({ id, kind: 'plan', surface: 'home', skill: 'tv-ad', brief, expect: e, ...extra });
const show = (id: string, brief: string, e: PlanCase['expect'], extra: Partial<PlanCase> = {}): PlanCase => ({ id, kind: 'plan', surface: 'home', skill: 'product-showcase', brief, expect: e, ...extra });
const board = (id: string, brief: string, e: PlanCase['expect'], extra: Partial<PlanCase> = {}): PlanCase => ({ id, kind: 'plan', surface: 'home', skill: 'storyboard', brief, expect: e, ...extra });
const comic = (id: string, brief: string, e: PlanCase['expect'], extra: Partial<PlanCase> = {}): PlanCase => ({ id, kind: 'plan', surface: 'home', skill: 'ai-comic', brief, expect: e, ...extra });
const brand = (id: string, brief: string, e: PlanCase['expect'], extra: Partial<PlanCase> = {}): PlanCase => ({ id, kind: 'plan', surface: 'home', skill: 'brand-kit', brief, expect: e, ...extra });
const fields = (id: string, tool: FieldTool, brief: string, keepWords: string[], extra: Partial<FieldsCase> = {}): FieldsCase => ({ id, kind: 'fields', surface: 'tool', brief, expect: { tool, keepWords }, ...extra });

/** The 40 golden briefs. */
export const BRIEFS: EvalCase[] = [
  // TV ad (10)
  ad('tv-01-sparkling-water', '15-second vertical ad for a sparkling water brand called Ridgeline. Open on the cap popping, end on the logo. Use the product photo.', { shots: [2, 5], seconds: 15, ratio: '9:16' }, { refs: [PRODUCT_PHOTO.id], golden: true }),
  ad('tv-02-coffee-30', '30 second TV spot for a neighborhood coffee roaster, warm morning mood, 16:9.', { shots: [4, 8], seconds: 30, ratio: '16:9' }),
  ad('tv-03-running-shoes', 'A 15s ad for lightweight running shoes, city at night, fast energy.', { shots: [2, 5], seconds: 15 }),
  ad('tv-04-bank-app', '6-second bumper for a banking app: phone in hand, one tap, money sent. Vertical.', { shots: [1, 2], seconds: 6, ratio: '9:16' }),
  ad('tv-05-skincare', '20 second vertical ad for a vitamin C serum, clean bathroom, soft daylight.', { shots: [3, 5], seconds: 20, ratio: '9:16' }),
  ad('tv-06-budget', '15 second ad for a dog food brand, happy dog in a park. Keep the whole thing under 600 credits.', { shots: [2, 5], seconds: 15, maxCredits: 600 }),
  ad('tv-07-ev', '30 second widescreen commercial for an electric SUV driving along a coastal road at sunrise.', { shots: [4, 8], seconds: 30, ratio: '16:9' }),
  ad('tv-08-pizza', 'Make a 10 second square ad for a pizza delivery app, cheese pull close-up first.', { shots: [2, 3], seconds: 10, ratio: '1:1' }),
  ad('tv-09-german', 'Erstelle einen 15-Sekunden-Werbespot im Hochformat für ein Bio-Müsli, Frühstückstisch, sonnig.', { shots: [2, 5], seconds: 15, ratio: '9:16' }, { account: { language: 'de' } }),
  ad('tv-10-japanese', '新しい緑茶ペットボトルの15秒の縦型CMを作ってください。山の朝、さわやかに。', { shots: [2, 5], seconds: 15, ratio: '9:16' }, { account: { language: 'ja' } }),
  // Product showcase (8)
  show('ps-01-watch', 'Showcase our steel dive watch: dial details, the bezel turning, on the wrist. 12 seconds.', { shots: [2, 4], seconds: 12 }),
  show('ps-02-headphones', 'Product video for wireless headphones, matte black, studio look, square, about 12 seconds.', { shots: [2, 4], seconds: 12, ratio: '1:1' }, { refs: [PRODUCT_PHOTO.id] }),
  show('ps-03-sneaker', '20 second product showcase of a white leather sneaker for our shop page.', { shots: [3, 6], seconds: 20 }),
  show('ps-04-lamp', 'Show a ceramic table lamp in a cozy living room at dusk, 12s, 16:9.', { shots: [2, 4], seconds: 12, ratio: '16:9' }),
  show('ps-05-bottle-ref', 'Turn this product photo into a 12 second vertical showcase with macro shots of the label.', { shots: [2, 4], seconds: 12, ratio: '9:16' }, { refs: [PRODUCT_PHOTO.id] }),
  show('ps-06-backpack', 'Outdoor backpack showcase, 16 seconds: pockets, waterproof zip, on a hiker.', { shots: [3, 5], seconds: 16 }),
  show('ps-07-cheap', 'Quick 8 second showcase of a scented candle, cheapest option please.', { shots: [1, 3], seconds: 8, maxCredits: 400 }),
  show('ps-08-chinese', '给我们的手工皮革钱包做一个12秒的产品展示视频，竖屏。', { shots: [2, 4], seconds: 12, ratio: '9:16' }, { account: { language: 'zh-TW' } }),
  // Storyboard (5)
  board('sb-01-lost-dog', 'Storyboard a 30 second short: a girl loses her dog in the rain and finds it under a bus stop.', { shots: [4, 8], seconds: 30 }),
  board('sb-02-startup', 'Storyboard for a 45s founder story video: garage, first customer, team today.', { shots: [5, 10], seconds: 45 }),
  board('sb-03-music', 'Plan shots for a 20 second music video teaser, neon alley, singer walking toward camera, vertical.', { shots: [3, 6], seconds: 20, ratio: '9:16' }),
  board('sb-04-recipe', 'Storyboard a 30s recipe video for avocado toast, top-down shots.', { shots: [4, 8], seconds: 30 }),
  board('sb-05-travel', 'Storyboard a 24 second travel teaser for Lisbon: tram, viewpoints, pastel de nata.', { shots: [3, 6], seconds: 24 }),
  // AI comic (6)
  comic('ac-01-robot', 'A short manga-style comic: a small robot learns to water a plant. About 20 seconds.', { shots: [3, 6], seconds: 20 }),
  comic('ac-02-detective', 'Noir comic, 5 panels, a cat detective in a rainy city.', { shots: [4, 6] }),
  comic('ac-03-webtoon', 'Vertical webtoon motion comic, 4 panels, two friends at a summer festival.', { shots: [4, 4], ratio: '9:16' }),
  comic('ac-04-space', 'Western comic book style, 24 seconds, an astronaut finds a garden on Mars.', { shots: [3, 6], seconds: 24 }),
  comic('ac-05-watercolor', 'Watercolor comic about a grandmother teaching her grandson to fish, 6 panels.', { shots: [5, 7] }),
  comic('ac-06-korean', '한 소녀가 고양이와 함께 우주를 여행하는 4컷 만화를 만들어 주세요.', { shots: [4, 4] }, { account: { language: 'ko' } }),
  // Brand kit (3)
  brand('bk-01-tea', 'Brand kit visuals for a tea shop called Leaf & Co: deep green and off-white, calm. Use the logo.', { shots: [3, 6], seconds: 16 }, { refs: [LOGO.id] }),
  brand('bk-02-gym', 'Set of brand loops for a boutique gym, black and orange, bold, about 16 seconds total.', { shots: [3, 6], seconds: 16 }),
  brand('bk-03-bakery', 'Brand visuals for a bakery: logo sting, bread texture loop, end card, 12 seconds.', { shots: [3, 5], seconds: 12 }),
  // Talking head (4, avatar tool)
  fields('th-01-welcome', 'avatar', 'A friendly host says: "Welcome to Ridgeline. Today we show you three ways to enjoy sparkling water." Office background.', ['Welcome to Ridgeline', 'three ways']),
  fields('th-02-product', 'avatar', 'Presenter in a kitchen explains: "This blender crushes ice in five seconds." Vertical.', ['crushes ice in five seconds']),
  fields('th-03-course', 'avatar', 'Teacher avatar says "Lesson one: how to hold the camera steady" in a bright classroom.', ['Lesson one', 'hold the camera steady']),
  fields('th-04-spanish', 'avatar', 'Una presentadora dice: "Hola, bienvenidos a nuestra tienda online." Fondo blanco.', ['bienvenidos a nuestra tienda'], { account: { language: 'es' } }),
  // Character (4, character tool)
  fields('ch-01-maya', 'character', 'Maya, a woman in her thirties with short black hair, denim jacket, calm and curious.', ['short black hair', 'denim jacket']),
  fields('ch-02-knight', 'character', 'An old knight named Bran, grey beard, dented armor, kind eyes, painterly style.', ['grey beard', 'dented armor']),
  fields('ch-03-mascot', 'character', 'Our mascot Pip: a round orange fox, big ears, wears a blue scarf, cartoon style.', ['orange fox', 'blue scarf']),
  fields('ch-04-chef', 'character', 'Chef Ana, fifties, curly grey hair, white apron, warm smile.', ['curly grey hair', 'white apron']),
];

/** Canvas patches (golden path step 9) and Simple-mode quick fields. */
export const CANVAS_CASES: EvalCase[] = [
  { id: 'cv-01-warmer', kind: 'graphPatch', surface: 'canvas', skill: 'tv-ad', brief: 'make shot 2 warmer', golden: true, expect: { touch: ['node_shot2'], onlyTouch: true, params: ['prompt'] } },
  { id: 'cv-02-longer', kind: 'graphPatch', surface: 'canvas', brief: 'Make shot 1 last 8 seconds instead of 5.', expect: { touch: ['node_shot1'], onlyTouch: true, params: ['seconds'] } },
  { id: 'cv-03-add-logo', kind: 'graphPatch', surface: 'canvas', skill: 'tv-ad', brief: 'Add a third shot: the bottle centered with the logo, 4 seconds, starting from the keyframe.', expect: { touch: [], addKinds: ['video'] } },
  { id: 'cv-04-selected', kind: 'graphPatch', surface: 'canvas', brief: 'Use 720p and a slower camera move for this one.', selection: ['node_shot1'], expect: { touch: ['node_shot1'], onlyTouch: true } },
  fields('qk-01-quick', 'quick', 'a red fox running through snow at sunrise, slow motion, 5 seconds, vertical', ['red fox', 'snow']),
  fields('rx-01-remix', 'remix', 'keep the bottle but change the background to a beach at sunset', ['beach at sunset']),
];

/** Timeline edits (section 8 and golden path step 10). */
export const TIMELINE_CASES: TimelineCase[] = [
  { id: 'tl-01-cut-10', kind: 'timeline', surface: 'editor', brief: 'cut to 10s', edit: 'cutTo', golden: true, expect: { duration: 10 } },
  { id: 'tl-02-swap', kind: 'timeline', surface: 'editor', brief: 'swap shot 2 and 3', edit: 'swap', expect: { swap: ['v2', 'v3'] } },
  { id: 'tl-03-music', kind: 'timeline', surface: 'editor', brief: 'lower the music', edit: 'lowerMusic', expect: {} },
  { id: 'tl-04-captions', kind: 'timeline', surface: 'editor', brief: 'make captions shorter', edit: 'shorterCaptions', expect: {} },
  { id: 'tl-05-cut-12', kind: 'timeline', surface: 'editor', brief: 'Trim the whole thing down to 12 seconds.', edit: 'cutTo', expect: { duration: 12 } },
  { id: 'tl-06-remove', kind: 'timeline', surface: 'editor', brief: 'remove the second shot and close the gap', edit: 'removeShot', expect: { removed: 'v2' } },
];

export const ALL_CASES: EvalCase[] = [...BRIEFS, ...CANVAS_CASES, ...TIMELINE_CASES];
