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
const vid = (prompt: string, ratio: string, length: number, model = VIDEO) => ({
  model,
  prompt,
  ratio,
  resolution: '720p',
  length,
});

/** A presenter speaking to camera: portrait → framed still → speaking clip. */
function talking(id: string, title: string, description: string, ratio: string, still: string, motion: string, tags: string[]): BuiltinTemplate {
  return tpl(
    id,
    title,
    'talking',
    description,
    graph(
      [
        ['photo', 'asset', 'Presenter photo', { media: 'image' }, 0, 0],
        ['frame', 'image', 'Framing', img(still, ratio), 1, 0],
        ['speak', 'video', 'Talking', vid(motion, ratio, 5, VIDEO_FAST), 2, 0],
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
function drama(id: string, title: string, description: string, cast: string, shots: Array<[still: string, motion: string]>, ratio = '9:16'): BuiltinTemplate {
  const ids = shots.map((_, i) => i + 1);
  return tpl(
    id,
    title,
    'drama',
    description,
    graph(
      [
        ['cast', 'text', 'Cast', { text: cast }, 0, 1],
        ...shots.map(([still], i): N => [`k${i + 1}`, 'image', `Keyframe ${i + 1}`, img(`Cinematic film still: ${still}`, ratio), 1, i]),
        ...shots.map(([, motion], i): N => [`v${i + 1}`, 'video', `Shot ${i + 1}`, vid(motion, ratio, 5, VIDEO_FAST), 2, i]),
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
    'A three-shot 15-second ad for one product: script, keyframes from your product photo, then motion. Cut and export in the editor.',
    graph(
      [
        [
          'script',
          'script',
          'Script',
          {
            text: 'Shot 1: the product on a clean surface, morning light. Shot 2: a hand picks it up, close-up. Shot 3: the product with the brand line.',
          },
          0,
          1,
        ],
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

  // Product picks (D-002 cheap defaults: Seedream 5.0 Lite keyframes, Seedance 2.0 Mini motion).
  tpl(
    'tpl_unboxing_reel',
    'Unboxing reel',
    'product',
    'Hands open the box and reveal your product, in a vertical clip for stories and reels.',
    graph(
      [
        ['product', 'asset', 'Product photo', { media: 'image' }, 0, 0],
        ['reveal', 'image', 'Reveal', img('Top-down view of hands opening a plain kraft gift box on a wooden table, the product inside, soft daylight', '9:16'), 1, 0],
        ['clip', 'video', 'Unboxing', vid('The hands lift the lid and the product is revealed, gentle camera push-in', '9:16', 5, VIDEO_FAST), 2, 0],
      ],
      [
        ['product', 'reveal', 'refs'],
        ['reveal', 'clip', 'frame'],
      ],
    ),
    { tags: ['Vertical', '5 seconds', 'Product photo'] },
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
    'A host introduces your channel or brand to camera in a bright studio.',
    '16:9',
    'The presenter stands in a bright, minimal studio, medium shot, looking at the camera',
    'The presenter smiles and speaks to the camera, natural hand gestures: "Hi, welcome to the channel."',
    ['Presenter', '5 seconds', '1 character'],
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
  // Short drama: three-shot vertical episodes; the cast description feeds every keyframe.
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
