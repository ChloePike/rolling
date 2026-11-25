/**
 * Built-in templates (seeded into D1 by migration 0016, generated from this
 * file by `packages/db/scripts/seed-templates.ts`). Every model id is a real
 * catalog id (D-002) and every setting fits the Starter plan caps (D-006:
 * 720p video, 2K images), so a new project runs as soon as its slots are filled.
 */
import type { GraphEdge, GraphNode, NodeKind } from '../graph/types';
import { inferSlots, summarizeGraph, type TemplateGraph, type TemplateMeta } from './slots';

export const TEMPLATE_CATEGORIES = ['product', 'explainer', 'drama', 'holiday', 'venue', 'outfit', 'comic', 'talking'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface BuiltinTemplate {
  id: string;
  title: string;
  category: TemplateCategory;
  description: string;
  graph: TemplateGraph;
  meta: TemplateMeta;
}

const IMAGE = 'bytedance/seedream-5.0-lite';
const VIDEO = 'bytedance/seedance-2.5';
const VIDEO_FAST = 'bytedance/seedance-2.0-mini';
const LIP_SYNC = 'lumina/wan2.7-i2v-spicy';

type N = [id: string, kind: NodeKind, title: string, params: Record<string, unknown>, col: number, row: number];
type E = [from: string, to: string, port: string];

function graph(nodes: N[], edges: E[], groups: Array<{ id: string; title: string; nodeIds: string[] }> = []): TemplateGraph {
  const groupOf = new Map(groups.flatMap((g) => g.nodeIds.map((id) => [id, g.id] as const)));
  return {
    nodes: nodes.map(
      ([id, kind, title, params, col, row]): GraphNode => ({
        id,
        kind,
        title,
        params,
        position: { x: col * 340, y: row * 240 },
        groupId: groupOf.get(id) ?? null,
        status: 'idle',
        createdBy: 'user',
      }),
    ),
    edges: edges.map(([from, to, port], i): GraphEdge => ({ id: `edge_t${i + 1}`, from: { node: from, port: 'out' }, to: { node: to, port } })),
    groups,
  };
}

function tpl(id: string, title: string, category: TemplateCategory, description: string, g: TemplateGraph, extra: Partial<TemplateMeta> = {}): BuiltinTemplate {
  return { id, title, category, description, graph: g, meta: summarizeGraph(g, extra) };
}

const img = (prompt: string, ratio: string, extra: Record<string, unknown> = {}) => ({ model: IMAGE, prompt, ratio, resolution: '2K', ...extra });
const vid = (prompt: string, ratio: string, length: number, model = VIDEO) => ({ model, prompt, ratio, resolution: '720p', length });

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  tpl(
    'tpl_tv_ad_15s',
    'TV ad, 15 seconds',
    'product',
    'A three-shot 15-second ad for one product: script, keyframes from your product photo, then motion. Cut and export in the editor.',
    graph(
      [
        ['script', 'script', 'Script', { text: 'Shot 1: the product on a clean surface, morning light. Shot 2: a hand picks it up, close-up. Shot 3: the product with the brand line.' }, 0, 1],
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['k1', 'image', 'Keyframe 1', img('The product on a clean surface in soft morning light, wide shot', '16:9'), 1, 0],
        ['k2', 'image', 'Keyframe 2', img('A hand picks up the product, close-up, shallow depth of field', '16:9'), 1, 1],
        ['k3', 'image', 'Keyframe 3', img('Hero shot of the product, centered, room for a brand line', '16:9'), 1, 2],
        ['v1', 'video', 'Shot 1', vid('Slow push-in on the product', '16:9', 5), 2, 0],
        ['v2', 'video', 'Shot 2', vid('The hand lifts the product toward the camera', '16:9', 5), 2, 1],
        ['v3', 'video', 'Shot 3', vid('Gentle orbit around the product, ends still', '16:9', 5), 2, 2],
      ],
      [
        ['product', 'k1', 'refs'],
        ['product', 'k2', 'refs'],
        ['product', 'k3', 'refs'],
        ['k1', 'v1', 'frame'],
        ['k2', 'v2', 'frame'],
        ['k3', 'v3', 'frame'],
      ],
      [{ id: 'grp_t1', title: 'Shots', nodeIds: ['k1', 'k2', 'k3', 'v1', 'v2', 'v3'] }],
    ),
    { tags: ['3 shots', '15 seconds', 'Product photo'], featured: true, skill: 'tv-ad' },
  ),
  tpl(
    'tpl_product_showcase',
    'Product showcase',
    'product',
    'Two clean angles of one product turned into short loops for a product page or social post.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['front', 'image', 'Front angle', img('Studio product shot, front view, seamless light background', '1:1'), 1, 0],
        ['detail', 'image', 'Detail', img('Macro detail of the product material and texture', '1:1'), 1, 1],
        ['loop1', 'video', 'Turntable', vid('The product turns slowly on a turntable', '1:1', 5, VIDEO_FAST), 2, 0],
        ['loop2', 'video', 'Detail move', vid('Slow slide across the detail', '1:1', 5, VIDEO_FAST), 2, 1],
      ],
      [
        ['product', 'front', 'refs'],
        ['product', 'detail', 'refs'],
        ['front', 'loop1', 'frame'],
        ['detail', 'loop2', 'frame'],
      ],
    ),
    { tags: ['2 loops', 'Square', 'Product photo'] },
  ),
  tpl(
    'tpl_talking_head',
    'Talking head',
    'talking',
    'A photo speaks your voice track: lip-synced video for intros, explainers and announcements.',
    graph(
      [
        ['photo', 'asset', 'Portrait photo', { media: 'image' }, 0, 0],
        ['voice', 'asset', 'Voice track', { media: 'audio' }, 0, 1],
        ['speak', 'video', 'Talking head', { model: LIP_SYNC, prompt: 'The person speaks to the camera with natural expressions and small head movements.', resolution: '720p', length: 10, audio: true }, 1, 0],
      ],
      [
        ['photo', 'speak', 'frame'],
        ['voice', 'speak', 'audio'],
      ],
    ),
    { tags: ['Lip sync', 'Your voice', '1 character'], featured: true },
  ),
  tpl(
    'tpl_comic_page',
    'Comic page',
    'comic',
    'Four panels from a short script with one recurring character, drawn in a consistent style.',
    graph(
      [
        ['script', 'script', 'Story', { text: 'Panel 1: the hero wakes up late. Panel 2: runs for the bus. Panel 3: misses it. Panel 4: a friend offers a ride.' }, 0, 1],
        ['hero', 'asset', 'Character', { media: 'image' }, 0, 0],
        ['p1', 'image', 'Panel 1', img('Comic panel, clean ink lines, flat colors: the hero wakes up late', '1:1'), 1, 0],
        ['p2', 'image', 'Panel 2', img('Comic panel, clean ink lines, flat colors: the hero runs for the bus', '1:1'), 1, 1],
        ['p3', 'image', 'Panel 3', img('Comic panel, clean ink lines, flat colors: the bus leaves without the hero', '1:1'), 2, 0],
        ['p4', 'image', 'Panel 4', img('Comic panel, clean ink lines, flat colors: a friend offers a ride', '1:1'), 2, 1],
      ],
      [
        ['hero', 'p1', 'refs'],
        ['hero', 'p2', 'refs'],
        ['hero', 'p3', 'refs'],
        ['hero', 'p4', 'refs'],
      ],
      [{ id: 'grp_t1', title: 'Panels', nodeIds: ['p1', 'p2', 'p3', 'p4'] }],
    ),
    { tags: ['4 panels', 'Consistent character'] },
  ),
  tpl(
    'tpl_character_sheet',
    'Character sheet',
    'comic',
    'A full-body turnaround and expressions for one character, to reuse across shots.',
    graph(
      [
        ['ref', 'asset', 'Reference picture', { media: 'image' }, 0, 0],
        ['desc', 'text', 'Description', { text: 'A young courier in a yellow rain jacket, short dark hair, friendly face.' }, 0, 1],
        ['front', 'image', 'Front', img('Full-body character reference, front view, neutral pose, plain background', '3:4'), 1, 0],
        ['side', 'image', 'Side', img('Full-body character reference, side view, neutral pose, plain background', '3:4'), 1, 1],
        ['faces', 'image', 'Expressions', img('Character expression sheet: happy, surprised, thinking, tired; plain background', '1:1'), 1, 2],
      ],
      [
        ['ref', 'front', 'refs'],
        ['ref', 'side', 'refs'],
        ['ref', 'faces', 'refs'],
        ['desc', 'front', 'prompt'],
        ['desc', 'side', 'prompt'],
        ['desc', 'faces', 'prompt'],
      ],
    ),
    { tags: ['Turnaround', 'Expressions'] },
  ),
  tpl(
    'tpl_storyboard',
    'Storyboard, 6 shots',
    'explainer',
    'Six keyframes from a script to plan a video before spending on motion.',
    graph(
      [
        ['script', 'script', 'Script', { text: 'A short story in six shots.' }, 0, 1],
        ...[1, 2, 3, 4, 5, 6].map((i): N => [`s${i}`, 'image', `Shot ${i}`, img(`Storyboard frame ${i}, cinematic composition, muted colors`, '16:9'), 1 + Math.floor((i - 1) / 3), (i - 1) % 3]),
      ],
      [1, 2, 3, 4, 5, 6].map((i): E => ['script', `s${i}`, 'prompt']),
      [{ id: 'grp_t1', title: 'Storyboard', nodeIds: ['s1', 's2', 's3', 's4', 's5', 's6'] }],
    ),
    { tags: ['6 frames', 'No motion'] },
  ),
  tpl(
    'tpl_holiday_greeting',
    'Holiday greeting',
    'holiday',
    'A festive still from your photo that comes alive in a short vertical clip.',
    graph(
      [
        ['photo', 'asset', 'Photo', { media: 'image' }, 0, 0],
        ['card', 'image', 'Greeting card', img('Festive holiday scene, warm lights, snow outside the window, the subject in the center', '9:16'), 1, 0],
        ['clip', 'video', 'Greeting', vid('Snow falls, lights twinkle, the subject waves', '9:16', 5, VIDEO_FAST), 2, 0],
      ],
      [
        ['photo', 'card', 'refs'],
        ['card', 'clip', 'frame'],
      ],
    ),
    { tags: ['Vertical', '5 seconds'] },
  ),
  tpl(
    'tpl_outfit_try_on',
    'Outfit try-on',
    'outfit',
    'A model photo wearing an outfit you supply, then a short walk toward the camera.',
    graph(
      [
        ['model', 'asset', 'Model photo', { media: 'image' }, 0, 0],
        ['outfit', 'asset', 'Outfit', { media: 'image' }, 0, 1],
        ['look', 'image', 'Look', img('The person wears the outfit, full body, street background, natural light', '9:16'), 1, 0],
        ['walk', 'video', 'Walk', vid('The person walks toward the camera and turns', '9:16', 5), 2, 0],
      ],
      [
        ['model', 'look', 'refs'],
        ['outfit', 'look', 'refs'],
        ['look', 'walk', 'frame'],
      ],
    ),
    { tags: ['2 pictures', 'Vertical'] },
  ),
];

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/** SQL that upserts the built-in templates (keeps their `uses`). Written to migration 0016 by `apps/api/scripts/seed-templates.ts`. */
export function builtinTemplatesSql(templates: readonly BuiltinTemplate[] = BUILTIN_TEMPLATES): string {
  const rows = templates.map((t) => {
    const slots = JSON.stringify(inferSlots(t.graph));
    return `INSERT INTO templates (id, workspace_id, title, category, graph, slots, preview_asset_id, uses, description, meta, created_at, updated_at) VALUES (${q(t.id)}, NULL, ${q(t.title)}, ${q(t.category)}, ${q(JSON.stringify(t.graph))}, ${q(slots)}, NULL, 0, ${q(t.description)}, ${q(JSON.stringify(t.meta))}, 0, 0)\n  ON CONFLICT (id) DO UPDATE SET title = excluded.title, category = excluded.category, graph = excluded.graph, slots = excluded.slots, description = excluded.description, meta = excluded.meta;`;
  });
  return rows.join('\n') + '\n';
}
