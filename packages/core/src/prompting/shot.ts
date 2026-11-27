/**
 * Structured shot spec: what a shot shows, as fields instead of one free-text
 * prompt (docs/harness-research.md). The agent fills these; `./compose.ts`
 * turns them into the prompt each model family reads best. The canonical
 * prompt (`canonicalPrompt`) is the neutral English prose stored on the node
 * (`params.prompt`) so the user can read and edit it; a node whose prompt no
 * longer matches its shot was edited by hand and is sent as typed.
 */
import { z } from 'zod';

export const SHOT_SIZES = ['extreme_wide', 'wide', 'full', 'medium', 'medium_close_up', 'close_up', 'extreme_close_up'] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const CAMERA_ANGLES = ['eye_level', 'low_angle', 'high_angle', 'overhead', 'aerial', 'over_the_shoulder', 'pov'] as const;
export type CameraAngle = (typeof CAMERA_ANGLES)[number];

export const CAMERA_MOVES = [
  'static',
  'push_in',
  'pull_out',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'truck_left',
  'truck_right',
  'pedestal_up',
  'pedestal_down',
  'orbit',
  'tracking',
  'handheld',
  'zoom_in',
  'zoom_out',
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const CHARACTER_KINDS = ['person', 'animal', 'object'] as const;
/** What a recurring "character" is: a person, an animal, or a thing (a product, a vehicle, a logo). */
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

/** A recurring character: the same words in every shot it appears in. */
export interface ShotCharacter {
  name: string;
  /** Absent means a person. Decides how it is described and how its reference picture is drawn. */
  kind?: CharacterKind;
  /** What stays the same in every shot. A person: age band, build, face, hair. A thing: shape, material, color, markings. */
  look: string;
  /** A person's outfit and props in this video. For an animal or a thing: a fixed accessory or state (a collar, the cap on). */
  wardrobe?: string;
}

export interface ShotCamera {
  size?: ShotSize;
  angle?: CameraAngle;
  /** One move per shot. */
  move?: CameraMove;
  /** Lens or focus note, e.g. "85mm, shallow depth of field". */
  lens?: string;
}

/** A line spoken on camera (audio-capable models voice it; the others drop it). */
export interface ShotDialogue {
  speaker: string;
  line: string;
  /** Delivery, e.g. "calm", "whispering". */
  tone?: string;
}

export interface ShotSpec {
  /** Who or what we see, with the details that matter. */
  subject: string;
  /** What happens, in order: one or two beats that fit the shot length. */
  action: string;
  /** Where and when. */
  setting?: string;
  camera?: ShotCamera;
  lighting?: string;
  /** Look of the whole video (medium, palette, grade): the same words on every shot. */
  style?: string;
  /** Recurring characters in this shot, with their fixed descriptors. */
  characters?: ShotCharacter[];
  dialogue?: ShotDialogue[];
  /** Ambience and sound effects. */
  sound?: string;
  /** Music direction; leave out for no music. */
  music?: string;
  /** On-screen text that must read exactly. */
  text?: string;
}

const Short = (max: number) => z.string().trim().min(1).max(max);

export const ShotCharacterSchema = z.object({
  name: Short(40),
  kind: z.enum(CHARACTER_KINDS).optional(),
  look: Short(240),
  wardrobe: Short(200).optional(),
});

export const ShotSpecSchema = z.object({
  subject: Short(400),
  action: Short(400),
  setting: Short(300).optional(),
  camera: z
    .object({
      size: z.enum(SHOT_SIZES).optional(),
      angle: z.enum(CAMERA_ANGLES).optional(),
      move: z.enum(CAMERA_MOVES).optional(),
      lens: Short(80).optional(),
    })
    .optional(),
  lighting: Short(200).optional(),
  style: Short(200).optional(),
  characters: z.array(ShotCharacterSchema).max(5).optional(),
  dialogue: z.array(z.object({ speaker: Short(40), line: Short(300), tone: Short(60).optional() })).max(3).optional(),
  sound: Short(200).optional(),
  music: Short(120).optional(),
  text: Short(80).optional(),
});

/** What the composed text is for. */
export type PromptPurpose =
  /** A whole clip from text (or reference media): everything is described. */
  | 'video'
  /** A clip that starts from a picture: motion and camera lead, the picture carries the look. */
  | 'animate'
  /** One still picture: the opening frame of the shot. No motion, camera move or sound. */
  | 'still';

// ---------------------------------------------------------------- text helpers

/** One sentence: trimmed, single-spaced, ending in punctuation. */
export function sentence(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?。！？"”')\]]$/.test(t) ? t : `${t}.`;
}

/** Text without its final period, for use inside a longer sentence. */
export function clause(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
}

export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const SIZE_WORDS: Record<ShotSize, string> = {
  extreme_wide: 'extreme wide shot',
  wide: 'wide shot',
  full: 'full shot',
  medium: 'medium shot',
  medium_close_up: 'medium close-up',
  close_up: 'close-up',
  extreme_close_up: 'extreme close-up',
};

const ANGLE_WORDS: Record<CameraAngle, string> = {
  eye_level: 'eye level',
  low_angle: 'low angle',
  high_angle: 'high angle',
  overhead: 'overhead view',
  aerial: 'aerial view',
  over_the_shoulder: 'over the shoulder',
  pov: 'first-person view',
};

/** Plain camera sentences every model reads ("The camera slowly pushes in"). */
export const MOVE_SENTENCES: Record<CameraMove, string> = {
  static: 'The camera stays fixed',
  push_in: 'The camera slowly pushes in',
  pull_out: 'The camera slowly pulls out',
  pan_left: 'The camera pans left',
  pan_right: 'The camera pans right',
  tilt_up: 'The camera tilts up',
  tilt_down: 'The camera tilts down',
  truck_left: 'The camera moves left',
  truck_right: 'The camera moves right',
  pedestal_up: 'The camera rises',
  pedestal_down: 'The camera lowers',
  orbit: 'The camera orbits slowly around the subject',
  tracking: 'The camera follows the subject',
  handheld: 'Handheld camera with slight natural shake',
  zoom_in: 'The camera zooms in',
  zoom_out: 'The camera zooms out',
};

export function sizeWords(size: ShotSize | undefined): string {
  return size ? SIZE_WORDS[size] : '';
}

export function angleWords(angle: CameraAngle | undefined): string {
  return angle ? ANGLE_WORDS[angle] : '';
}

/** "Medium close-up, low angle" (empty when the shot sets neither). */
export function framing(camera: ShotCamera | undefined): string {
  return [sizeWords(camera?.size), angleWords(camera?.angle)].filter(Boolean).join(', ');
}

/**
 * The fixed descriptor of a character: the exact same string in every shot it
 * appears in, which is what keeps a face and an outfit stable across separate
 * generations.
 */
export function characterDescriptor(c: ShotCharacter): string {
  const look = clause(c.look);
  const wardrobe = clause(c.wardrobe).replace(/^wearing\s+/i, '');
  // Only people wear things: a bottle "wearing condensation" reads as nonsense to an image model.
  const worn = !wardrobe ? '' : (c.kind ?? 'person') === 'person' ? `; wearing ${wardrobe}` : `; ${wardrobe}`;
  return `${c.name} (${look}${worn})`;
}

/** Title of the node that holds a character's reference picture; `referenceSentences` reads the prefix back. */
export function characterSheetTitle(c: Pick<ShotCharacter, 'name' | 'kind'>): string {
  const prefix = c.kind === 'object' ? 'Product' : c.kind === 'animal' ? 'Animal' : 'Character';
  return `${prefix}: ${c.name}`.slice(0, 200);
}

/** "Characters: Maya (...), Leo (...)." or empty. */
export function castSentence(characters: readonly ShotCharacter[] | undefined, label = 'Characters'): string {
  if (!characters?.length) return '';
  return `${label}: ${characters.map(characterDescriptor).join(', ')}.`;
}

/** `Maya says (calm): "..."` in neutral form. */
export function dialogueSentence(d: ShotDialogue): string {
  const line = d.line.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  return `${d.speaker} says${d.tone ? ` (${clause(d.tone)})` : ''}: "${line}"`;
}

/**
 * Neutral English prompt for a shot: the text stored on the node and shown to
 * the user. Every field of the shot is in it (the safety checks read this
 * text), in the order most vendor guides share: style, framing and subject,
 * action, setting, light, camera, then sound.
 */
export function canonicalPrompt(shot: ShotSpec, purpose: PromptPurpose = 'video'): string {
  const frame = framing(shot.camera);
  const parts: string[] = [];
  if (shot.style) parts.push(sentence(capitalize(clause(shot.style))));
  parts.push(sentence(frame ? `${capitalize(frame)} of ${clause(shot.subject)}` : capitalize(clause(shot.subject))));
  parts.push(castSentence(shot.characters));
  parts.push(sentence(capitalize(clause(shot.action))));
  if (shot.setting) parts.push(sentence(capitalize(clause(shot.setting))));
  if (shot.lighting) parts.push(sentence(capitalize(clause(shot.lighting))));
  if (shot.camera?.lens) parts.push(sentence(capitalize(clause(shot.camera.lens))));
  if (shot.text) parts.push(`The text "${clause(shot.text)}" is clearly readable.`);
  if (purpose !== 'still') {
    if (shot.camera?.move) parts.push(sentence(MOVE_SENTENCES[shot.camera.move]));
    for (const d of shot.dialogue ?? []) parts.push(dialogueSentence(d));
    if (shot.sound) parts.push(sentence(`Sound: ${clause(shot.sound)}`));
    if (shot.music) parts.push(sentence(`Music: ${clause(shot.music)}`));
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function normalize(text: string): string {
  return text.replace(/@\[([^\]]*)\]/g, '$1').replace(/\s+/g, ' ').trim();
}

/**
 * The shot a node carries, when its prompt is still the one composed from it.
 * Null when there is no (valid) shot or the prompt was edited by hand: an
 * edited prompt is the user's own text and is sent as typed.
 */
export function shotOfParams(kind: 'image' | 'video', params: Record<string, unknown>): ShotSpec | null {
  if (!params.shot || typeof params.shot !== 'object') return null;
  const parsed = ShotSpecSchema.safeParse(params.shot);
  if (!parsed.success) return null;
  const shot = parsed.data as ShotSpec;
  const prompt = typeof params.prompt === 'string' ? normalize(params.prompt) : '';
  return prompt === canonicalPrompt(shot, kind === 'image' ? 'still' : 'video') ? shot : null;
}

/**
 * Reference-sheet shot for a character: one neutral picture every keyframe of
 * that character is drawn from (keyframes take it as a reference image), so
 * separate generations share a face and an outfit, or a product its shape and
 * label. A person is drawn head to toe, an animal standing side-on, a thing as
 * a plain product picture.
 */
export function characterSheetShot(c: ShotCharacter, style?: string): ShotSpec {
  const base = { setting: 'Plain light grey studio background', lighting: 'Soft, even studio lighting', ...(style ? { style } : {}) };
  if (c.kind === 'object') {
    return {
      subject: `${characterDescriptor(c)}, the whole object alone in the frame`,
      action: 'Resting still, seen from the front at a slight three-quarter angle',
      camera: { size: 'medium', angle: 'eye_level' },
      ...base,
    };
  }
  if (c.kind === 'animal') {
    return {
      subject: `${characterDescriptor(c)}, the whole animal from nose to tail`,
      action: 'Standing still, seen from the side with the head turned to the camera',
      camera: { size: 'full', angle: 'eye_level' },
      ...base,
    };
  }
  return {
    subject: `${characterDescriptor(c)}, the whole figure from head to toe`,
    action: 'Standing in a relaxed neutral pose, facing the camera',
    camera: { size: 'full', angle: 'eye_level' },
    ...base,
  };
}
