/**
 * Tool input schemas (docs/harness.md section 3). Every tool input the model
 * can send is checked with these before anything runs. Written with zod/v4 so
 * the JSON Schema sent to the model comes from the same definition.
 */
import { CAMERA_ANGLES, CAMERA_MOVES, SHOT_SIZES } from '@rolling/core/prompting';
import { z } from 'zod/v4';

const Id = z.string().min(1).max(80);
const NODE_KINDS = ['text', 'script', 'image', 'video', 'audio', 'asset', 'render'] as const;

// ---------------------------------------------------------------- read tools

export const CanvasGetInput = z.object({
  projectId: Id,
  nodeIds: z.array(Id).max(50).optional().describe('Only these nodes in full; omit for the whole canvas'),
});

export const ScriptGetInput = z.object({ nodeId: Id });

export const AssetsSearchInput = z.object({
  query: z.string().max(200),
  scope: z.enum(['mine', 'team', 'builtin', 'public', 'all']).default('all'),
  kind: z.enum(['image', 'video', 'audio', 'text']).optional(),
});

export const EmptyInput = z.object({});

export const ModelsCapabilitiesInput = z.object({ kind: z.enum(['video', 'image', 'avatar']) });

export const PricingEstimateInput = z.object({
  items: z
    .array(
      z.object({
        model: Id,
        kind: z.enum(['video', 'image', 'avatar']),
        seconds: z.number().positive().max(120).optional(),
        count: z.number().int().positive().max(16).optional(),
        resolution: z.string().max(16).optional(),
      }),
    )
    .min(1)
    .max(40),
});

export const TemplatesSearchInput = z.object({ query: z.string().max(200) });

export const TimelineGetInput = z.object({ canvasId: Id });

// ---------------------------------------------------------------- propose tools

/** Marks a property the model is not shown (still accepted when sent). */
const HIDDEN = '@hidden';

export const ShotCameraInput = z.object({
  size: z.enum(SHOT_SIZES).optional().describe('Shot size'),
  angle: z.enum(CAMERA_ANGLES).optional(),
  move: z.enum(CAMERA_MOVES).optional().describe('One camera move for the whole shot; static when the camera should not move'),
  lens: z.string().max(80).optional().describe('Lens or focus note, e.g. "85mm, shallow depth of field"'),
});

export const ShotDialogueInput = z.object({
  speaker: z.string().min(1).max(40).describe('Character name, exactly as in characters'),
  line: z.string().min(1).max(300).describe('The exact words, in the language they are spoken in, without quotes'),
  tone: z.string().max(60).optional().describe('Delivery in a word or two, e.g. calm, laughing'),
});

/** The parts of a shot. The server writes the prompt each model reads best from them. */
export const ShotFieldsInput = {
  subject: z.string().min(1).max(400).optional().describe('Who or what we see, in English, with the visible details that matter. Name recurring characters by name only: their look comes from characters'),
  action: z.string().min(1).max(400).optional().describe('What happens, in English, as one sentence naming who does what: one or two beats that fit the shot length'),
  setting: z.string().max(300).optional().describe('Where and when, in English'),
  camera: ShotCameraInput.optional(),
  lighting: z.string().max(200).optional().describe('Light source, quality and color, in English'),
  cast: z.array(z.string().min(1).max(40)).max(5).optional().describe('Names from characters that appear in this shot'),
  dialogue: z.array(ShotDialogueInput).max(3).optional().describe('Words spoken on camera in this shot. Only on a model with audio; about 2 words per second'),
  sound: z.string().max(200).optional().describe('Ambience and sound effects, in English. Only on a model with audio'),
  text: z.string().max(80).optional().describe('On-screen text that must read exactly (a logo line, a sign)'),
} as const;

export const PlanShot = z.object({
  title: z.string().min(1).max(80),
  seconds: z.number().positive().max(60).describe('Whole seconds inside the model range'),
  ...ShotFieldsInput,
  visual: z.string().min(1).max(600).optional().describe(HIDDEN),
  line: z.string().max(400).optional().describe('Voiceover or caption for this shot, in the user language; goes to the script and captions, not into the picture'),
  model: Id.describe('Video model id, exactly as models.capabilities lists it'),
});

export const PlanCharacter = z.object({
  name: z.string().min(1).max(40),
  look: z.string().min(1).max(240).describe('Fixed look in English: age band, build, face, hair. Adults unless the user says otherwise'),
  wardrobe: z.string().max(200).optional().describe('Outfit and props for this video, in English'),
});

export const PlanOption = z.object({
  title: z.string().min(1).max(80),
  look: z.string().max(200).optional().describe('Look of the whole video in English (medium, palette, grade); applied to every shot'),
  characters: z.array(PlanCharacter).max(5).optional().describe('Recurring characters. Each is described once here and reused word for word in every shot that lists it in cast'),
  shots: z.array(PlanShot).min(1).max(12),
  estimate: z.number().int().nonnegative().optional().describe('Ignored: the server computes the estimate'),
  ratio: z.string().min(3).max(12).describe('Aspect ratio for every shot: 9:16 vertical, 16:9 widescreen, 1:1 square'),
  resolution: z.string().max(12).optional().describe('Video resolution for every shot; default is the model default'),
});

export const ProposePlanInput = z.object({
  seconds: z.number().positive().max(600).describe('Total length the user asked for (or the skill default); each option must add up to it within 10%'),
  options: z.array(PlanOption).min(2).max(3),
  summary: z.string().max(400).optional(),
});

const XY = z.object({ x: z.number(), y: z.number() });
const PortRef = z.object({ node: Id, port: z.string().min(1).max(32) });
const Params = z.record(z.string(), z.unknown());

/** GraphOp from docs/harness.md section 5 (the agent may not move or ungroup). */
export const AgentGraphOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addNode'),
    tempId: z.string().min(1).max(40).describe('Short temp id like t1, referenced by later ops'),
    kind: z.enum(NODE_KINDS),
    title: z.string().max(200),
    params: Params.describe('Video: shot {subject, action, setting?, camera?, lighting?, style?, characters?, dialogue?, sound?, text?} or prompt, plus model, mode, seconds, resolution, ratio, audio. Image: shot or prompt, plus model, mode, ratio, count'),
    position: XY.optional(),
  }),
  z.object({
    op: z.literal('updateNode'),
    nodeId: Id,
    params: Params.describe('Only what changes. On a node that has a shot, send shot with just the fields that change (the server merges them and rewrites the prompt); otherwise send prompt'),
    title: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('connect'), from: PortRef, to: PortRef }),
  z.object({ op: z.literal('disconnect'), edgeId: Id }),
  z.object({ op: z.literal('removeNode'), nodeId: Id }),
  z.object({ op: z.literal('group'), nodeIds: z.array(Id).min(1).max(100), title: z.string().max(200) }),
]);
export type AgentGraphOp = z.infer<typeof AgentGraphOp>;

export const ProposeGraphPatchInput = z.object({
  projectId: Id,
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(AgentGraphOp).min(1).max(80),
  summary: z.string().min(1).max(400),
});

const ClipId = z.string().min(1).max(64);
const Seconds = z.number().min(0).max(24 * 3600);

/** TimelineOp from docs/harness.md section 5. */
export const AgentTimelineOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim'), clipId: ClipId, in: Seconds.optional(), out: Seconds.optional() }),
  z.object({ op: z.literal('move'), clipId: ClipId, start: Seconds }),
  z.object({ op: z.literal('split'), clipId: ClipId, at: Seconds }),
  z.object({ op: z.literal('remove'), clipId: ClipId, ripple: z.boolean() }),
  z.object({ op: z.literal('setGain'), clipId: ClipId, gainDb: z.number().min(-96).max(24) }),
  z.object({ op: z.literal('setCaption'), clipId: ClipId, text: z.string().max(2000) }),
  z.object({ op: z.literal('replaceShot'), clipId: ClipId, nodeId: Id }),
  // Effects the editor supports (core TimelineOpSchema). Not offered to the agent: insert,
  // setFormat and replaceEdl (no media insertion or whole-cut rewrites from a chat turn).
  z.object({ op: z.literal('setSpeed'), clipId: ClipId, speed: z.number().min(0.25).max(4), reverse: z.boolean().optional() }),
  z.object({ op: z.literal('setFade'), clipId: ClipId, fadeIn: z.number().min(0).max(600) }),
  z.object({
    op: z.literal('setTransition'),
    clipId: ClipId,
    transition: z.object({ type: z.literal('dissolve'), dur: z.number().gt(0).max(10) }).nullable(),
  }),
]);

export const ProposeTimelinePatchInput = z.object({
  canvasId: Id,
  baseRevision: z.number().int().nonnegative(),
  ops: z.array(AgentTimelineOp).min(1).max(120),
  summary: z.string().min(1).max(400),
});

export const FIELD_TOOLS = ['quick', 'remix', 'avatar', 'character'] as const;
export type FieldTool = (typeof FIELD_TOOLS)[number];

export const ProposeFieldsInput = z.object({
  tool: z.enum(FIELD_TOOLS),
  fields: z.record(z.string(), z.unknown()),
});

/** Structured fields per Simple-mode tool (filled from the user's free text). */
export const FIELD_SCHEMAS = {
  quick: z.object({
    kind: z.enum(['video', 'image']),
    prompt: z.string().min(1).max(2000),
    model: Id.optional(),
    seconds: z.number().positive().max(60).optional(),
    ratio: z.string().max(12).optional(),
    resolution: z.string().max(12).optional(),
    audio: z.boolean().optional(),
    count: z.number().int().min(1).max(8).optional(),
  }),
  remix: z.object({
    sourceAssetId: Id.optional(),
    prompt: z.string().min(1).max(2000).describe('What to change, in the user words'),
    keep: z.array(z.string().max(200)).max(10).optional(),
    model: Id.optional(),
    strength: z.enum(['subtle', 'balanced', 'strong']).optional(),
  }),
  avatar: z.object({
    script: z.string().min(1).max(4000).describe('Exactly what the avatar says, user words kept'),
    look: z.string().max(600).optional(),
    characterId: Id.optional(),
    voiceId: Id.optional(),
    background: z.string().max(400).optional(),
    ratio: z.string().max(12).optional(),
  }),
  character: z.object({
    name: z.string().min(1).max(80),
    look: z.string().min(1).max(1200),
    outfit: z.string().max(600).optional(),
    personality: z.string().max(600).optional(),
    style: z.string().max(200).optional(),
  }),
} as const satisfies Record<FieldTool, z.ZodType>;

// ---------------------------------------------------------------- JSON Schema

/** JSON Schema for the model, without noise the providers do not need. */
export function toToolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return strip(json) as Record<string, unknown>;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '$schema') continue;
    if (v && typeof v === 'object' && (v as { description?: unknown }).description === HIDDEN) continue;
    if ((k === 'maximum' || k === 'minimum') && typeof v === 'number' && Math.abs(v) >= Number.MAX_SAFE_INTEGER) continue;
    if (k === 'propertyNames') continue;
    out[k] = strip(v);
  }
  return out;
}

/** First Zod issue as one short line for the model. */
export function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
    .join('; ');
}
