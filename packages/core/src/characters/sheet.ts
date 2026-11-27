/**
 * Character sheet (turnaround) in one run (D-032): a full-body picture first,
 * then every other view drawn from it (image edit with the full body as
 * Image 1), so the face, hair, build and outfit of one generation carry into
 * all views. People get front, 3/4, profile and 2 to 3 expressions; animals
 * and things get the four angles only.
 *
 * Pure planning data: the run planner (`generation/specPlan.ts`) turns these
 * into run items, the Worker saves the outputs as the character's sheet.
 */
import { z } from 'zod';
import { canonicalPrompt, characterSheetShot } from '../prompting/shot';
import { descriptorToShotCharacter, type CharacterDescriptor, type OutfitInput } from './descriptor';

export const SHEET_ANGLES = ['full_body', 'front', 'three_quarter', 'profile'] as const;
export type SheetAngle = (typeof SHEET_ANGLES)[number];

export const SHEET_EXPRESSIONS = ['smile', 'serious', 'surprised', 'sad', 'angry'] as const;
export type SheetExpression = (typeof SHEET_EXPRESSIONS)[number];
export const DEFAULT_EXPRESSIONS: readonly SheetExpression[] = ['smile', 'serious'];
export const MAX_EXPRESSIONS = 3;

export type ExpressionView = `expression_${SheetExpression}`;
export type SheetView = SheetAngle | ExpressionView;
export const SHEET_VIEWS: readonly SheetView[] = [...SHEET_ANGLES, ...SHEET_EXPRESSIONS.map((e) => `expression_${e}` as const)];
export const SheetViewSchema = z.enum(SHEET_VIEWS as [SheetView, ...SheetView[]]);

/** Asset id per view (a version's sheet, or an outfit variant's views). */
export type SheetAssets = Partial<Record<SheetView, string>>;

export function isExpressionView(v: SheetView): v is ExpressionView {
  return v.startsWith('expression_');
}

export function expressionOf(v: SheetView): SheetExpression | null {
  return isExpressionView(v) ? (v.slice('expression_'.length) as SheetExpression) : null;
}

/** Words for each view in titles and reference labels ("Maya · 3/4 view"). */
export const VIEW_LABELS: Record<SheetView, string> = {
  full_body: 'full body',
  front: 'front',
  three_quarter: '3/4 view',
  profile: 'profile',
  expression_smile: 'smiling',
  expression_serious: 'serious',
  expression_surprised: 'surprised',
  expression_sad: 'sad',
  expression_angry: 'angry',
};

const EXPRESSION_WORDS: Record<SheetExpression, string> = {
  smile: 'a warm, natural smile',
  serious: 'a serious, focused expression',
  surprised: 'a surprised expression with raised eyebrows',
  sad: 'a sad, downcast expression',
  angry: 'an angry expression with a furrowed brow',
};

/** One picture of the sheet run. `from` = the view it is drawn from (an item of the same run), null = drawn from the description and the user's references. */
export interface SheetItem {
  view: SheetView;
  /** Run item ref: the view id (outfit variants use the same refs). */
  ref: string;
  title: string;
  ratio: string;
  prompt: string;
  from: SheetView | null;
}

export type SheetMode = 'new' | 'version' | 'outfit';

export interface SheetPlanInput {
  name: string;
  descriptor: CharacterDescriptor;
  /** People only; 0 to 3 (default smile and serious). */
  expressions?: readonly SheetExpression[];
  mode?: SheetMode;
  /** Outfit variant: the new outfit (face, hair and build stay). */
  outfit?: OutfitInput;
  /** The saved picture the run starts from: the current full body (outfit) or the previous front view (version). */
  base?: boolean;
  /** User reference pictures given with the request (they follow the base picture). */
  references?: number;
}

/** Views a sheet of this kind contains, in run order (the full body first). */
export function sheetViews(kind: CharacterDescriptor['kind'], expressions: readonly SheetExpression[] = DEFAULT_EXPRESSIONS): SheetView[] {
  const angles: SheetView[] = [...SHEET_ANGLES];
  if (kind !== 'person') return angles;
  const ex = [...new Set(expressions)].slice(0, MAX_EXPRESSIONS).map((e) => `expression_${e}` as const);
  return [...angles, ...ex];
}

/** Views an outfit variant draws: the outfit shows in the full body and the 3/4 view. */
export const OUTFIT_VIEWS: readonly SheetView[] = ['full_body', 'three_quarter'];

const BACKDROP = 'Plain light grey studio background. Soft, even studio lighting.';

function keep(kind: CharacterDescriptor['kind'], name: string): string {
  if (kind === 'object') return `Image 1 is ${name}: keep its shape, materials, colors and markings identical.`;
  if (kind === 'animal') return `Image 1 is ${name}: keep the same animal, with identical coat, markings and build.`;
  return `Image 1 is the character ${name}: keep the face, hair, build and outfit identical.`;
}

function viewDirection(kind: CharacterDescriptor['kind'], view: SheetView): string {
  if (kind === 'object') {
    switch (view) {
      case 'front':
        return 'The whole object seen straight from the front.';
      case 'three_quarter':
        return 'The whole object seen from a three-quarter angle.';
      case 'profile':
        return 'The whole object seen from the side.';
      default:
        return 'The whole object alone in the frame.';
    }
  }
  if (kind === 'animal') {
    switch (view) {
      case 'front':
        return 'Head and chest, facing the camera.';
      case 'three_quarter':
        return 'The whole animal turned three-quarters toward the camera.';
      case 'profile':
        return 'The whole animal seen from the side, in profile.';
      default:
        return 'The whole animal from nose to tail.';
    }
  }
  const ex = expressionOf(view);
  if (ex) return `Close-up portrait, face and shoulders, facing the camera, with ${EXPRESSION_WORDS[ex]}.`;
  switch (view) {
    case 'front':
      return 'Head-and-shoulders portrait facing the camera, neutral expression, eyes to the lens.';
    case 'three_quarter':
      return 'Upper body turned three-quarters to the left, face toward the camera, neutral expression.';
    case 'profile':
      return 'Head and shoulders in side profile facing left, neutral expression.';
    default:
      return 'The whole figure from head to toe, standing in a relaxed neutral pose, facing the camera.';
  }
}

const RATIOS: Record<SheetView, string> = {
  full_body: '3:4',
  front: '1:1',
  three_quarter: '3:4',
  profile: '1:1',
  expression_smile: '1:1',
  expression_serious: '1:1',
  expression_surprised: '1:1',
  expression_sad: '1:1',
  expression_angry: '1:1',
};

function titleOf(name: string, view: SheetView, outfit?: OutfitInput): string {
  const v = VIEW_LABELS[view];
  const label = v.charAt(0).toUpperCase() + v.slice(1);
  return `${name}${outfit ? ` · ${outfit.name}` : ''} · ${label}`.slice(0, 200);
}

/**
 * The run items of a sheet: the full body (from the description, the base
 * picture and the user's references), then each other view drawn from it.
 */
export function sheetItems(input: SheetPlanInput): SheetItem[] {
  const { name, descriptor: d } = input;
  const mode = input.mode ?? 'new';
  const outfit = mode === 'outfit' ? input.outfit : undefined;
  const character = descriptorToShotCharacter(name, d, outfit ?? null);
  const views = mode === 'outfit' ? [...OUTFIT_VIEWS] : sheetViews(d.kind, input.expressions ?? DEFAULT_EXPRESSIONS);
  const style = d.style ? `${d.style.replace(/[.\s]+$/, '')}.` : '';
  const describe = canonicalPrompt(characterSheetShot(character, d.style || undefined), 'still');
  const items: SheetItem[] = [];
  for (const view of views) {
    if (view === 'full_body') {
      let prompt = describe;
      if (mode === 'outfit' && input.base) {
        prompt = [
          `Image 1 is the character ${name}: keep the face, hair and build identical.`,
          `Change only the outfit to: ${outfit?.outfit.replace(/[.\s]+$/, '')}.`,
          viewDirection(d.kind, 'full_body'),
          BACKDROP,
          style,
        ]
          .filter(Boolean)
          .join(' ');
      } else if (mode === 'version' && input.base) {
        prompt = [`Image 1 is the earlier look of ${name}: keep the same person and face.`, describe].join(' ');
      } else if ((input.references ?? 0) > 0) {
        prompt = [`Draw the ${d.kind === 'person' ? 'person' : d.kind} in the reference pictures.`, describe].join(' ');
      }
      items.push({ view, ref: view, title: titleOf(name, view, outfit), ratio: RATIOS[view], prompt, from: null });
      continue;
    }
    const prompt = [keep(d.kind, name), viewDirection(d.kind, view), BACKDROP, style].filter(Boolean).join(' ');
    items.push({ view, ref: view, title: titleOf(name, view, outfit), ratio: RATIOS[view], prompt, from: 'full_body' });
  }
  return items;
}

/** Reference label of a sheet picture; `referenceSentences` (prompting) reads it back as a character binding. */
export function sheetReferenceLabel(kind: CharacterDescriptor['kind'], name: string, view: SheetView): string {
  const prefix = kind === 'object' ? 'Product' : kind === 'animal' ? 'Animal' : 'Character';
  return `${prefix}: ${name} · ${VIEW_LABELS[view]}`.slice(0, 80);
}
