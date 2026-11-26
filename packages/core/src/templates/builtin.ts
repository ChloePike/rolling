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
/** People-heavy scenes (faces, hands, crowds): Seedream 5.5 keyframes, Wan 3.0 motion; same Starter caps. */
const IMAGE_PEOPLE = 'bytedance/seedream-5.5';
const VIDEO_PEOPLE = 'lumina/berry-1.0';
/** Appended to every people-scene still: fictional adults, nothing a viewer could read as a brand. */
const PEOPLE_NOTE = 'Fictional adults only, no real people. No logos, no brand marks, no readable text.';

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
    edges: edges.map(
      ([from, to, port], i): GraphEdge => ({
        id: `edge_t${i + 1}`,
        from: { node: from, port: 'out' },
        to: { node: to, port },
      }),
    ),
    groups,
  };
}

function tpl(id: string, title: string, category: TemplateCategory, description: string, g: TemplateGraph, extra: Partial<TemplateMeta> = {}): BuiltinTemplate {
  return {
    id,
    title,
    category,
    description,
    graph: g,
    meta: summarizeGraph(g, extra),
  };
}

const img = (prompt: string, ratio: string, extra: Record<string, unknown> = {}) => ({ model: IMAGE, prompt, ratio, resolution: '2K', ...extra });
/** A people-scene keyframe (Seedream 5.5) with the fictional-adults, no-brands note. */
const still = (prompt: string, ratio: string) => img(`${prompt} ${PEOPLE_NOTE}`, ratio, { model: IMAGE_PEOPLE });
const vid = (prompt: string, ratio: string, length: number, model = VIDEO) => ({
  model,
  prompt,
  ratio,
  resolution: '720p',
  length,
});

/** A presenter speaking to camera: portrait → framed still → speaking clip. */
function talking(
  id: string,
  title: string,
  description: string,
  ratio: string,
  framing: string,
  motion: string,
  tags: string[],
  people = false,
  photoTitle = 'Presenter photo',
): BuiltinTemplate {
  return tpl(
    id,
    title,
    'talking',
    description,
    graph(
      [
        ['photo', 'asset', photoTitle, { media: 'image' }, 0, 0],
        ['frame', 'image', 'Framing', people ? still(framing, ratio) : img(framing, ratio), 1, 0],
        ['speak', 'video', 'Talking', vid(motion, ratio, 5, people ? VIDEO_PEOPLE : VIDEO_FAST), 2, 0],
      ],
      [
        ['photo', 'frame', 'refs'],
        ['frame', 'speak', 'frame'],
      ],
    ),
    { tags },
  );
}

/** A three-shot drama episode: cast description → three keyframes → three clips. */
function drama(id: string, title: string, description: string, cast: string, shots: Array<[still: string, motion: string]>, ratio = '9:16', people = false): BuiltinTemplate {
  const ids = shots.map((_, i) => i + 1);
  return tpl(
    id,
    title,
    'drama',
    description,
    graph(
      [
        ['cast', 'text', 'Cast', { text: cast }, 0, 1],
        ...shots.map(([s], i): N => [`k${i + 1}`, 'image', `Keyframe ${i + 1}`, people ? still(`Cinematic film still: ${s}`, ratio) : img(`Cinematic film still: ${s}`, ratio), 1, i]),
        ...shots.map(([, motion], i): N => [`v${i + 1}`, 'video', `Shot ${i + 1}`, vid(motion, ratio, 5, people ? VIDEO_PEOPLE : VIDEO_FAST), 2, i]),
      ],
      [...ids.map((i): E => ['cast', `k${i}`, 'prompt']), ...ids.map((i): E => [`k${i}`, `v${i}`, 'frame'])],
      [
        {
          id: 'grp_t1',
          title: 'Shots',
          nodeIds: [...ids.map((i) => `k${i}`), ...ids.map((i) => `v${i}`)],
        },
      ],
    ),
    {
      tags: [`${shots.length} shots`, ratio === '9:16' ? 'Vertical' : 'Widescreen', `${shots.length * 5} seconds`],
    },
  );
}

/** A festive still that comes alive; `withProduct` adds a product photo reference. */
function holiday(id: string, title: string, description: string, ratio: string, still: string, motion: string, tags: string[], withProduct = false): BuiltinTemplate {
  return tpl(
    id,
    title,
    'holiday',
    description,
    graph(
      [...(withProduct ? [['product', 'asset', 'Product photo', { media: 'image' }, 0, 0] as N] : []), ['still', 'image', 'Festive still', img(still, ratio), 1, 0], ['clip', 'video', 'Clip', vid(motion, ratio, 5, VIDEO_FAST), 2, 0]],
      [...(withProduct ? [['product', 'still', 'refs'] as E] : []), ['still', 'clip', 'frame']],
    ),
    { tags },
  );
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  tpl(
    'tpl_tv_ad_15s',
    'TV ad, 15 seconds',
    'product',
    'A three-shot 15-second ad where people use your product in a real place: script, keyframes from your product photo, then motion. Cut and export in the editor.',
    graph(
      [
        [
          'script',
          'script',
          'Script',
          {
            text: 'Shot 1: a runner pauses on a city rooftop at golden hour and drinks from the product. Shot 2: close-up of her hand holding it, the skyline behind. Shot 3: the product on the ledge, friends laughing behind, room for the brand line.',
          },
          0,
          1,
        ],
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        [
          'k1',
          'image',
          'Keyframe 1',
          still(
            'Commercial film still at golden hour on a city rooftop: a woman in her thirties in running gear pauses mid-workout and drinks from the product, two friends stretching behind her, skyline and low sun behind, warm backlight with a soft lens flare, 35mm lens, medium-wide shot, shallow depth of field, warm teal-and-amber grade.',
            '16:9',
          ),
          1,
          0,
        ],
        [
          'k2',
          'image',
          'Keyframe 2',
          still('Commercial close-up: her hand grips the product, droplets on the surface, the skyline soft behind, golden rim light, 85mm lens at f/1.8, warm grade.', '16:9'),
          1,
          1,
        ],
        [
          'k3',
          'image',
          'Keyframe 3',
          still('Commercial hero shot: the product on a concrete rooftop ledge at sunset, friends laughing out of focus behind, open sky on the left for a brand line, 50mm lens, warm grade.', '16:9'),
          1,
          2,
        ],
        ['v1', 'video', 'Shot 1', vid('She lowers the product after a long drink and laughs with a friend, wind in her hair, slow handheld push-in, golden hour', '16:9', 5, VIDEO_PEOPLE), 2, 0],
        ['v2', 'video', 'Shot 2', vid('Her hand lifts the product toward the camera, the skyline drifts behind, rack focus', '16:9', 5, VIDEO_PEOPLE), 2, 1],
        ['v3', 'video', 'Shot 3', vid('Slow arc around the product on the ledge as the friends laugh behind, ends still', '16:9', 5, VIDEO_PEOPLE), 2, 2],
      ],
      [
        ['product', 'k1', 'refs'],
        ['product', 'k2', 'refs'],
        ['product', 'k3', 'refs'],
        ['k1', 'v1', 'frame'],
        ['k2', 'v2', 'frame'],
        ['k3', 'v3', 'frame'],
      ],
      [
        {
          id: 'grp_t1',
          title: 'Shots',
          nodeIds: ['k1', 'k2', 'k3', 'v1', 'v2', 'v3'],
        },
      ],
    ),
    {
      tags: ['3 shots', '15 seconds', 'Product photo'],
      featured: true,
      skill: 'tv-ad',
    },
  ),
  tpl(
    'tpl_product_showcase',
    'Product showcase',
    'product',
    'Your product in someone’s hands in a styled real place, plus a detail shot, turned into short square loops for a product page or social post.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        [
          'front',
          'image',
          'In hand',
          still(
            'Lifestyle product photo: a barista in her late twenties in a denim apron holds the product out across the wooden counter of a busy sunlit cafe, regulars chatting and an espresso machine soft behind, morning window light from the left, 50mm lens, shallow depth of field, warm film grade.',
            '1:1',
          ),
          1,
          0,
        ],
        ['detail', 'image', 'Detail', still('Macro detail of the product in her hands, its material and texture, warm window light, cafe bokeh behind, 100mm macro lens.', '1:1'), 1, 1],
        ['loop1', 'video', 'Hand-off', vid('She turns the product in her hands, smiles and offers it to the camera, people move behind, slow push-in', '1:1', 5, VIDEO_PEOPLE), 2, 0],
        ['loop2', 'video', 'Detail move', vid('Slow slide across the detail as her fingers turn the product', '1:1', 5, VIDEO_PEOPLE), 2, 1],
      ],
      [
        ['product', 'front', 'refs'],
        ['product', 'detail', 'refs'],
        ['front', 'loop1', 'frame'],
        ['detail', 'loop2', 'frame'],
      ],
    ),
    { tags: ['2 loops', 'Square', 'In hand'] },
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
        [
          'speak',
          'video',
          'Talking head',
          {
            model: LIP_SYNC,
            prompt: 'The person speaks to the camera with natural expressions and small head movements.',
            resolution: '720p',
            length: 10,
            audio: true,
          },
          1,
          0,
        ],
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
        [
          'script',
          'script',
          'Story',
          {
            text: 'Panel 1: the hero wakes up late. Panel 2: runs for the bus. Panel 3: misses it. Panel 4: a friend offers a ride.',
          },
          0,
          1,
        ],
        ['hero', 'asset', 'Character', { media: 'image' }, 0, 0],
        ['p1', 'image', 'Panel 1', img('Comic panel, clean ink lines, flat colors, no lettering or speech bubbles: the hero wakes up late', '1:1'), 1, 0],
        ['p2', 'image', 'Panel 2', img('Comic panel, clean ink lines, flat colors, no lettering or speech bubbles: the hero runs for the bus', '1:1'), 1, 1],
        ['p3', 'image', 'Panel 3', img('Comic panel, clean ink lines, flat colors, no lettering or speech bubbles: the bus leaves without the hero', '1:1'), 2, 0],
        ['p4', 'image', 'Panel 4', img('Comic panel, clean ink lines, flat colors, no lettering or speech bubbles: a friend offers a ride', '1:1'), 2, 1],
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
        [
          'desc',
          'text',
          'Description',
          {
            text: 'A young courier in a yellow rain jacket, short dark hair, friendly face.',
          },
          0,
          1,
        ],
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
    'tpl_cooking_show',
    'Kitchen cooking show',
    'explainer',
    'A host and a guest chef cook together on a bright kitchen set: a wide two-shot and a plating close-up, for recipes and tutorials.',
    graph(
      [
        ['recipe', 'text', 'Recipe', { text: 'Charred spring vegetables with herb butter: toss in a hot pan, finish with butter and herbs, plate on a stone dish.' }, 0, 1],
        [
          'k1',
          'image',
          'Wide two-shot',
          still(
            'Cooking show still on a bright TV kitchen set: a host in his forties with a navy apron tosses vegetables in a flaming pan at a marble island while a guest chef in her thirties laughs and adds herbs, copper pans, open shelves of jars and a crew light visible at the edge, softbox key light, 35mm lens, medium-wide shot, clean warm grade.',
            '16:9',
          ),
          1,
          0,
        ],
        ['k2', 'image', 'Plating close-up', still('Close-up of the guest chef’s hands plating the dish on a stone plate, the host leaning in behind out of focus, steam rising, warm key light, 85mm lens, shallow depth of field.', '16:9'), 1, 1],
        ['v1', 'video', 'Cooking', vid('The host tosses the vegetables, flames flare up, the guest chef laughs and sprinkles herbs, slow dolly in', '16:9', 5, VIDEO_PEOPLE), 2, 0],
        ['v2', 'video', 'Plating', vid('Her hands set the last herb on the plate, steam drifts, slow push-in', '16:9', 5, VIDEO_PEOPLE), 2, 1],
      ],
      [
        ['recipe', 'k1', 'prompt'],
        ['recipe', 'k2', 'prompt'],
        ['k1', 'v1', 'frame'],
        ['k2', 'v2', 'frame'],
      ],
      [{ id: 'grp_t1', title: 'Shots', nodeIds: ['k1', 'k2', 'v1', 'v2'] }],
    ),
    { tags: ['2 shots', '2 people', '10 seconds'] },
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
      [
        {
          id: 'grp_t1',
          title: 'Storyboard',
          nodeIds: ['s1', 's2', 's3', 's4', 's5', 's6'],
        },
      ],
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
    'Your model wears the outfit in an editorial street scene, then walks toward the camera through the crowd.',
    graph(
      [
        ['model', 'asset', 'Model photo', { media: 'image' }, 0, 0],
        ['outfit', 'asset', 'Outfit', { media: 'image' }, 0, 1],
        [
          'look',
          'image',
          'Look',
          still(
            'Editorial street-fashion photo: the person wears the outfit, full body, mid-stride on a cobblestone street in an old city quarter at golden hour, cafe tables, passersby and a cyclist soft behind, warm light in shop windows, 85mm lens, shallow depth of field, Portra film grade.',
            '9:16',
          ),
          1,
          0,
        ],
        ['walk', 'video', 'Walk', vid('The person walks toward the camera with confidence, the outfit moves in the breeze, passersby cross behind, slow tracking shot backward', '9:16', 5, VIDEO_PEOPLE), 2, 0],
      ],
      [
        ['model', 'look', 'refs'],
        ['outfit', 'look', 'refs'],
        ['look', 'walk', 'frame'],
      ],
    ),
    { tags: ['2 pictures', 'Vertical', 'Street scene'] },
  ),

  // Product picks (D-002 cheap defaults: Seedream 5.0 Lite keyframes, Seedance 2.0 Mini motion).
  tpl(
    'tpl_unboxing_reel',
    'Unboxing reel',
    'product',
    'A creator opens the box at home and reveals your product, in a vertical clip for stories and reels.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        [
          'reveal',
          'image',
          'Reveal',
          still(
            'Lifestyle photo: a woman in her twenties sits cross-legged on a sunlit bedroom floor with a plain kraft box open on her lap, lifting the product out of tissue paper with a delighted smile, a rug, plants and an unmade bed behind, soft morning window light, 35mm lens, vertical framing, warm natural grade.',
            '9:16',
          ),
          1,
          0,
        ],
        ['clip', 'video', 'Unboxing', vid('She lifts the product out of the box and turns it toward the camera with a delighted smile, tissue paper rustles, gentle handheld push-in. The product keeps its own look; no added labels, captions or text', '9:16', 5, VIDEO_PEOPLE), 2, 0],
      ],
      [
        ['product', 'reveal', 'refs'],
        ['reveal', 'clip', 'frame'],
      ],
    ),
    { tags: ['Vertical', '5 seconds', 'Product photo'] },
  ),
  tpl(
    'tpl_market_handoff',
    'Market stall hand-off',
    'product',
    'A stallholder hands your product to a customer at a busy morning market, in a vertical clip for shops and makers.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        [
          'handoff',
          'image',
          'Hand-off',
          still(
            'Lifestyle photo at a busy open-air morning market: a stallholder in her fifties with a linen apron hands the product across a wooden table to a smiling customer in his thirties, crates of flowers and bread on the table, other shoppers browsing behind under plain cream canvas awnings, soft morning sun, 35mm lens, vertical framing, warm natural grade.',
            '9:16',
          ),
          1,
          0,
        ],
        ['clip', 'video', 'Clip', vid('She hands over the product with a smile, he turns it in his hands and laughs, shoppers pass behind, gentle handheld push-in', '9:16', 5, VIDEO_PEOPLE), 2, 0],
      ],
      [
        ['product', 'handoff', 'refs'],
        ['handoff', 'clip', 'frame'],
      ],
    ),
    { tags: ['Vertical', '5 seconds', 'In hand'] },
  ),
  tpl(
    'tpl_lifestyle_scene',
    'Lifestyle scene',
    'product',
    'Your product placed in a lived-in home scene, with slow camera motion for ads and product pages.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['scene', 'image', 'Scene', img('The product on a sunlit kitchen counter next to plants and a coffee cup, cozy lifestyle photo', '3:4'), 1, 0],
        ['clip', 'video', 'Camera move', vid('Slow dolly toward the product, steam rises from the coffee cup, sunlight flickers', '3:4', 5, VIDEO_FAST), 2, 0],
      ],
      [
        ['product', 'scene', 'refs'],
        ['scene', 'clip', 'frame'],
      ],
    ),
    { tags: ['5 seconds', 'Product photo'] },
  ),
  tpl(
    'tpl_flat_lay_promo',
    'Flat lay promo',
    'product',
    'A styled top-down flat lay around your product that drifts gently, sized for a square feed post.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['layout', 'image', 'Flat lay', img('Top-down flat lay of the product on a pastel paper background with matching props, clean shadows', '1:1'), 1, 0],
        ['clip', 'video', 'Drift', vid('Slow top-down drift across the flat lay, a hand places one last prop', '1:1', 5, VIDEO_FAST), 2, 0],
      ],
      [
        ['product', 'layout', 'refs'],
        ['layout', 'clip', 'frame'],
      ],
    ),
    { tags: ['Square', '5 seconds', 'Product photo'] },
  ),
  tpl(
    'tpl_feature_closeups',
    'Feature close-ups',
    'product',
    'Two macro close-ups of the details that sell your product, each with a slow reveal.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['c1', 'image', 'Close-up 1', img('Macro close-up of the product surface and material, dramatic side light, dark background', '16:9'), 1, 0],
        ['c2', 'image', 'Close-up 2', img('Macro close-up of a key product detail, shallow depth of field, dark background', '16:9'), 1, 1],
        ['v1', 'video', 'Reveal 1', vid('Light sweeps across the surface, slow push-in', '16:9', 5, VIDEO_FAST), 2, 0],
        ['v2', 'video', 'Reveal 2', vid('Rack focus onto the detail, slow lateral slide', '16:9', 5, VIDEO_FAST), 2, 1],
      ],
      [
        ['product', 'c1', 'refs'],
        ['product', 'c2', 'refs'],
        ['c1', 'v1', 'frame'],
        ['c2', 'v2', 'frame'],
      ],
      [{ id: 'grp_t1', title: 'Close-ups', nodeIds: ['c1', 'c2', 'v1', 'v2'] }],
    ),
    { tags: ['2 shots', '10 seconds', 'Product photo'] },
  ),
  // Talking head: a presenter speaking to camera. Lines go in the prompt; the video model animates the delivery.
  talking(
    'tpl_presenter_intro',
    'Presenter intro',
    'A host introduces your channel or brand to camera on a lit studio set.',
    '16:9',
    'The presenter mid-sentence on a lit loft studio set, one hand gesturing: brick wall, warm practical lamps, shelves, plants and a camera on a tripod behind, softbox key light from the left, medium shot, 35mm lens, shallow depth of field, gentle film grade',
    'The presenter speaks to the camera mid-sentence with natural hand gestures, the camera eases in slowly: "Hi, welcome to the channel."',
    ['Presenter', '5 seconds', 'Studio set'],
    true,
  ),
  talking(
    'tpl_product_review',
    'Product review to camera',
    'A creator holds up a product and gives a quick honest take, in a vertical selfie frame.',
    '9:16',
    'Vertical selfie-style shot of the presenter at home holding a small product up to the camera, soft window light',
    'The presenter talks to the camera about the product and turns it to show the side: "Here is what I like about it."',
    ['Vertical', 'Presenter', 'Review'],
  ),
  talking(
    'tpl_how_to_host',
    'How-to host',
    'A host explains a step at a kitchen counter, for tutorials and tips.',
    '16:9',
    'The presenter at a tidy kitchen counter with a cutting board and vegetables, medium shot, warm light',
    'The presenter explains the next step to the camera and points at the cutting board: "First, slice them thin."',
    ['Tutorial', 'Presenter', '5 seconds'],
  ),
  talking(
    'tpl_announcement',
    'Announcement',
    'A host at a desk shares news or an update, framed like a short bulletin.',
    '16:9',
    'The presenter seated at a clean desk with a laptop and a plant, office background softly blurred, medium close-up',
    'The presenter looks into the camera and announces the news with a friendly nod: "We have something new to share."',
    ['News', 'Presenter', '5 seconds'],
  ),
  talking(
    'tpl_testimonial',
    'Customer testimonial',
    'A happy customer shares a short review, shot handheld in vertical.',
    '9:16',
    'Vertical handheld shot of the presenter outdoors on a sunny street, casual clothes, natural light',
    'The presenter talks to the camera with enthusiasm, small handheld movement: "Honestly, it made my mornings easier."',
    ['Vertical', 'UGC', 'Presenter'],
  ),
  talking(
    'tpl_wedding_toast',
    'Wedding toast',
    'The best man raises a glass at the reception while the guests laugh around him.',
    '16:9',
    'The speaker mid-sentence at a wedding reception at night in a barn venue strung with warm lights: he stands in a navy suit holding a microphone and a raised champagne glass, guests at round tables laughing behind him, the couple soft at the head table, warm tungsten light, 50mm lens, shallow depth of field, warm film grade',
    'He speaks into the microphone and lifts his glass, the guests laugh and raise theirs, slow push-in. No subtitles, captions or on-screen text',
    ['Speech', 'Guests', '5 seconds'],
    true,
    'Speaker photo',
  ),
  // Short drama: three-shot vertical episodes; the cast description feeds every keyframe.
  drama(
    'tpl_drama_dinner_party',
    'Dinner party secret',
    'Six friends at a candlelit dinner, and one toast lets a secret slip.',
    'Six adult friends in their thirties at a dinner party: Nadia, long braids, emerald dress; Theo, short beard, white shirt; Lena, short blonde hair, black turtleneck; and three other guests.',
    [
      [
        'Wide shot of six friends around a long candlelit dinner table in a warm apartment, wine glasses, shared plates, string lights and plants behind, everyone mid-laugh, 35mm lens, warm amber grade',
        'Slow push-in down the table as the friends laugh and pass dishes, candles flicker',
      ],
      ['Medium shot of Nadia standing to give a toast, glass raised, the others looking up at her, candlelight on their faces, 50mm lens', 'Nadia raises her glass and starts to speak, the table goes quiet'],
      ['Close-up of Theo, his smile freezing, candles flickering, guests soft behind him, 85mm lens', 'Theo’s smile fades and he slowly sets down his glass'],
    ],
    '16:9',
    true,
  ),
  drama(
    'tpl_drama_last_rehearsal',
    'Last rehearsal',
    'A dance crew’s final run-through before opening night, and the lift that has never worked.',
    'Five adult dancers in their twenties in plain rehearsal clothes; the lead pair: Ines, tall, dark hair in a bun, grey leotard; Jonah, shaved head, loose white tee.',
    [
      [
        'Upright vertical frame, camera level with the floor: wide shot of five dancers standing mid-routine in a sunlit rehearsal studio with a wooden floor and tall windows, dust in the light beams, the choreographer watching from a chair with crossed arms, 24mm lens, warm natural grade',
        'The dancers move in sync across the floor, the camera glides alongside',
      ],
      ['Medium shot of Jonah lifting Ines overhead, both straining, the others watching and holding their breath, 35mm lens', 'Jonah lifts Ines and she holds the pose, the others start to cheer'],
      ['Close-up of the choreographer finally smiling, sunlight on her face, 85mm lens', 'She smiles and starts clapping slowly'],
    ],
    '9:16',
    true,
  ),
  drama(
    'tpl_drama_rooftop',
    'Rooftop confession',
    'Two friends on a city rooftop at dusk, and one finally says what they mean.',
    'Two adult friends in their late twenties: Maya, curly dark hair, denim jacket; Leo, short hair, grey hoodie.',
    [
      ['Wide shot of two friends sitting on a city rooftop at dusk, skyline lights coming on', 'Slow push-in as the wind moves their hair'],
      ['Close-up of Maya turning toward Leo, nervous smile', 'Maya speaks quietly, Leo looks up'],
      ['Over-the-shoulder shot of Leo reacting, the city behind', 'Leo smiles, the camera drifts back'],
    ],
  ),
  drama('tpl_drama_rain_reunion', 'Reunion in the rain', 'Old friends cross paths at a rainy bus stop after years apart.', 'Two adults in their thirties: Ana in a yellow raincoat; Sam in a dark coat with an umbrella.', [
    ['A rainy street at night, neon reflections, Ana waits at a bus stop', 'Rain falls, headlights pass, slow pan'],
    ['Sam stops under his umbrella and recognizes her, medium shot', 'Sam lowers the umbrella, surprised'],
    ['Both laugh under the shelter, warm light from a shop window', 'They step closer, rain continues, camera rises'],
  ]),
  drama('tpl_drama_office_twist', 'Office plot twist', 'A quiet late night at the office ends with a discovery nobody expected.', 'An adult office worker, Priya, glasses, navy blazer; the empty office is lit by desk lamps.', [
    ['Priya working late in an empty open-plan office, desk lamps glowing', 'Slow dolly along the desks toward Priya'],
    ['Close-up of a mysterious envelope sliding onto her desk', 'The envelope slides in, Priya freezes'],
    ['Priya looks up at the dark corridor, dramatic side light', 'Priya stands slowly, the lights flicker'],
  ]),
  drama(
    'tpl_drama_letter',
    'The letter',
    'A handwritten letter found in an old book changes a quiet afternoon.',
    'An adult man, Tom, in his forties, knit sweater, in a sunlit secondhand bookshop.',
    [
      ['Tom browsing shelves in a sunlit secondhand bookshop, dust in the light', 'Slow tracking shot along the shelves'],
      ['An old folded letter falls from a book onto the floor, close-up', 'The letter drifts down and lands'],
      ['Tom reads the letter by the window, moved', 'Tom lowers the letter and looks outside'],
    ],
    '16:9',
  ),
  drama('tpl_drama_cafe', 'Cafe meet-cute', 'A coffee order mix-up turns into a conversation.', 'Two adults in their twenties: Jade, short bob, green sweater; Ravi, curly hair, white shirt.', [
    ['A busy cozy cafe, the barista calls a name, two cups on the counter', 'Steam rises, slow push-in on the cups'],
    ['Jade and Ravi reach for the same cup at once, medium shot', 'Their hands stop, both look up'],
    ['They laugh and sit at a window table, afternoon light', 'They talk, the camera drifts sideways'],
  ]),
  drama('tpl_drama_cliffhanger', 'Episode cliffhanger', 'A tense last scene that ends on a question, for the end of an episode.', 'An adult woman, Elena, long dark coat, in a foggy train station at night.', [
    ['A foggy train station platform at night, a lone figure under a lamp', 'Fog rolls across the platform, slow push-in'],
    ['Elena checks an old pocket watch, close-up', 'The watch hands tick, her eyes rise'],
    ['A train arrives and its doors open on an empty carriage', 'The doors slide open, light spills out, hold'],
  ]),
  // Holiday campaigns: text-only, vertical, one festive still that comes alive.
  holiday(
    'tpl_new_year_countdown',
    'New Year countdown',
    'Fireworks over a city skyline for a countdown post.',
    '9:16',
    'Fireworks bursting over a city skyline at midnight, reflections on the river, festive and bright',
    'Fireworks burst and sparkle, the camera tilts up slowly',
    ['Vertical', '5 seconds', 'No photo needed'],
  ),
  holiday(
    'tpl_valentines_card',
    "Valentine's card",
    'A warm, simple card scene with flowers and a handwritten note.',
    '1:1',
    'A bouquet of red tulips and a handwritten note on a cafe table, warm afternoon light, soft focus',
    'Petals stir in a light breeze, sunlight moves across the table',
    ['Square', '5 seconds', 'No photo needed'],
  ),
  holiday(
    'tpl_halloween_teaser',
    'Halloween teaser',
    'Carved pumpkins on a porch for a spooky-cute seasonal post.',
    '9:16',
    'Glowing carved pumpkins on a wooden porch at dusk, autumn leaves, string lights, friendly and cozy',
    'Candles flicker inside the pumpkins, leaves drift past',
    ['Vertical', '5 seconds', 'No photo needed'],
  ),
  holiday(
    'tpl_lunar_new_year',
    'Lunar New Year greeting',
    'Red lanterns and plum blossoms for a festive greeting.',
    '9:16',
    'Red paper lanterns hanging over a street with plum blossoms, golden evening light, festive',
    'Lanterns sway gently, petals fall, slow upward tilt',
    ['Vertical', '5 seconds', 'No photo needed'],
  ),
  holiday(
    'tpl_holiday_sale',
    'Holiday sale promo',
    'Your product among gift boxes and lights for a seasonal sale.',
    '9:16',
    'The product among wrapped gift boxes and warm fairy lights on a table, room for sale text at the top',
    'Fairy lights twinkle, slow push-in on the product',
    ['Vertical', 'Product photo', '5 seconds'],
    true,
  ),
  // Venues and events: crowds and places, no photo needed.
  tpl(
    'tpl_concert_vlog',
    'Concert crowd vlog',
    'venue',
    'Friends film themselves in the crowd as the stage lights hit, for venue, festival and event promos.',
    graph(
      [
        [
          'crowd',
          'image',
          'In the crowd',
          still(
            'Vertical selfie-vlog frame seen from the front camera at arm’s length, no phone visible in the frame, at a packed outdoor concert at night: a woman in her twenties laughs into the lens, two friends beside her singing along, a crowd with raised hands behind, stage lights cutting through haze, confetti in the air, 24mm wide lens, saturated stage-light grade.',
            '9:16',
          ),
          1,
          0,
        ],
        ['clip', 'video', 'Vlog', vid('The friends jump and sing along, confetti falls, stage lights sweep through the haze, handheld selfie movement', '9:16', 5, VIDEO_PEOPLE), 2, 0],
      ],
      [['crowd', 'clip', 'frame']],
    ),
    { tags: ['Vertical', '5 seconds', 'Crowd'] },
  ),
];

/** Home inspiration categories first, then the rest, for the feed order below. */
const FEED_CATEGORY_ORDER: readonly TemplateCategory[] = ['product', 'talking', 'drama', 'holiday', 'comic', 'explainer', 'outfit', 'venue'];

/**
 * Built-in ids in feed order: round-robin across categories (Home inspiration ones first), in
 * file order within each, so "For you" opens on a mix. Stored as `created_at` (migration 0021),
 * which `GET /api/templates` sorts by after `uses`.
 */
export function builtinFeedOrder(templates: readonly BuiltinTemplate[] = BUILTIN_TEMPLATES): string[] {
  const lists = FEED_CATEGORY_ORDER.map((c) => templates.filter((t) => t.category === c)).filter((l) => l.length);
  const out: string[] = [];
  for (let i = 0; out.length < templates.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]!.id);
  return out;
}

/** SQL that stores the feed order as built-ins' `created_at` (larger = earlier in the list). */
export function builtinOrderSql(templates: readonly BuiltinTemplate[] = BUILTIN_TEMPLATES): string {
  const ids = builtinFeedOrder(templates);
  return ids.map((id, i) => `UPDATE templates SET created_at = ${ids.length - i} WHERE id = '${id}' AND workspace_id IS NULL;`).join('\n') + '\n';
}

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/**
 * SQL that upserts the built-in templates. Keeps their `uses`, and merges `meta` so the cover
 * fields set by a later migration (0020: `coverKey`, `previewKey`, sizes) survive a re-seed.
 * Written to a migration by `apps/api/scripts/seed-templates.ts` (0016, then 0019).
 */
export function builtinTemplatesSql(templates: readonly BuiltinTemplate[] = BUILTIN_TEMPLATES): string {
  const rows = templates.map((t) => {
    const slots = JSON.stringify(inferSlots(t.graph));
    return `INSERT INTO templates (id, workspace_id, title, category, graph, slots, preview_asset_id, uses, description, meta, created_at, updated_at) VALUES (${q(t.id)}, NULL, ${q(t.title)}, ${q(t.category)}, ${q(JSON.stringify(t.graph))}, ${q(slots)}, NULL, 0, ${q(t.description)}, ${q(JSON.stringify(t.meta))}, 0, 0)\n  ON CONFLICT (id) DO UPDATE SET title = excluded.title, category = excluded.category, graph = excluded.graph, slots = excluded.slots, description = excluded.description, meta = json_patch(templates.meta, excluded.meta);`;
  });
  return rows.join('\n') + '\n';
}
