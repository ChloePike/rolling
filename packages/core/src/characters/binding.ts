/**
 * Reference-locked generation (D-032): which sheet pictures a shot passes to
 * which model.
 *
 * - A video model that takes reference images (`refs`): the best matching
 *   view of each character goes straight to it, within its reference count.
 * - A video model without reference images that animates a first frame
 *   (`i2v`): the shot is chained, a keyframe from an image model that takes
 *   reference pictures (edit), then the video from that keyframe.
 * - An image model (a keyframe or a still) that edits: the views are its
 *   input pictures.
 * - Nothing takes pictures: only the locked descriptor reaches the prompt.
 *
 * One view per character first (in cast order), then a companion view (face
 * for a wide shot, body for a close-up) while the model has room. User `@`
 * pictures already wired count against the limit.
 */
import type { CatalogModel } from '../models/types';
import type { CharacterKind } from '../prompting/shot';
import { sheetReferenceLabel, type SheetAssets, type SheetView } from './sheet';
import { companionView, rankSheetViews, type ViewChoiceInput } from './views';

export type RefModel = Pick<CatalogModel, 'id' | 'kind' | 'operations' | 'maxReferenceImages' | 'maxInputImages'>;

/** A character of the shot with its saved sheet (the version in use). */
export interface CastSheet {
  characterId: string;
  name: string;
  kind: CharacterKind;
  views: SheetAssets;
  /** The outfit variant the shot wears: its views replace the body views (full body, 3/4). */
  outfitViews?: SheetAssets;
  outfitName?: string;
}

export interface BoundReference {
  characterId: string;
  name: string;
  view: SheetView;
  assetId: string;
  /** "Character: Maya · 3/4 view": the composed prompt binds the picture by it. */
  label: string;
}

export type ReferenceStrategy = 'refs' | 'edit' | 'chain' | 'text';

export interface ReferencePlan {
  strategy: ReferenceStrategy;
  /** Pictures for the model that takes them: the video (`refs`), the image (`edit`) or the keyframe (`chain`). */
  refs: BoundReference[];
  /** `chain`: the image model that draws the keyframe. */
  keyframeModel?: string;
  /** Mode of the video request: references, first frame (after a keyframe), or text. */
  videoMode?: 'refs' | 'i2v' | 't2v';
  /** Characters that got no picture (no sheet, or no room left); their descriptor still reaches the prompt. */
  unbound: string[];
}

export interface BindInput {
  model: RefModel;
  shot: ViewChoiceInput;
  cast: readonly CastSheet[];
  /** Reference pictures already wired (the user's `@` pictures). */
  otherRefs?: number;
  /** Image models that take reference pictures, preferred first (the chain's keyframe model). */
  keyframeModels?: readonly RefModel[];
  /** A cap below the model's own (e.g. a graph port that takes two pictures). */
  maxSlots?: number;
}

const BODY_VIEWS = new Set<SheetView>(['full_body', 'three_quarter']);

/** A character's usable views: the base sheet, with the outfit variant's body views over it. */
export function effectiveViews(c: Pick<CastSheet, 'views' | 'outfitViews'>): SheetAssets {
  const out: SheetAssets = { ...c.views };
  for (const [v, id] of Object.entries(c.outfitViews ?? {}) as [SheetView, string][]) if (BODY_VIEWS.has(v) && id) out[v] = id;
  return out;
}

function takesRefs(m: RefModel): boolean {
  return m.kind === 'video' && m.operations.includes('refs') && m.maxReferenceImages > 0;
}

function takesEdits(m: RefModel): boolean {
  return m.kind === 'image' && m.operations.includes('edit') && m.maxInputImages > 0;
}

/** Fills `slots` reference pictures: one view per character in cast order, then companions round-robin. */
export function allocateReferences(shot: ViewChoiceInput, cast: readonly CastSheet[], slots: number): { refs: BoundReference[]; unbound: string[] } {
  const refs: BoundReference[] = [];
  const unbound: string[] = [];
  const ranked = cast.map((c) => {
    const views = effectiveViews(c);
    const available = (Object.keys(views) as SheetView[]).filter((v) => !!views[v]);
    return { c, views, ranked: rankSheetViews(shot, available) };
  });
  const bind = (c: CastSheet, views: SheetAssets, view: SheetView) => {
    const name = c.outfitName && BODY_VIEWS.has(view) ? `${c.name} (${c.outfitName})` : c.name;
    refs.push({ characterId: c.characterId, name: c.name, view, assetId: views[view]!, label: sheetReferenceLabel(c.kind, name, view) });
  };
  for (const r of ranked) {
    const primary = r.ranked[0];
    if (!primary || refs.length >= slots) {
      unbound.push(r.c.name);
      continue;
    }
    bind(r.c, r.views, primary);
  }
  for (const r of ranked) {
    if (refs.length >= slots) break;
    const primary = r.ranked[0];
    if (!primary || !refs.some((x) => x.characterId === r.c.characterId)) continue;
    const second = companionView(primary, r.ranked);
    if (second && r.views[second] !== r.views[primary]) bind(r.c, r.views, second);
  }
  return { refs, unbound };
}

/** The reference plan of one shot for one model (see the module comment). */
export function bindCharacterReferences(input: BindInput): ReferencePlan {
  const { model, shot, cast } = input;
  const other = input.otherRefs ?? 0;
  const cap = (n: number) => Math.max(0, Math.min(n, input.maxSlots ?? Number.POSITIVE_INFINITY) - other);
  // `maxSlots` limits the model being bound; a keyframe is a separate image node with its own limit.
  const capKeyframe = (n: number) => Math.max(0, n - other);
  const withSheet = cast.filter((c) => Object.values(effectiveViews(c)).some(Boolean));
  const noSheet = cast.filter((c) => !withSheet.includes(c)).map((c) => c.name);
  if (withSheet.length === 0) return { strategy: 'text', refs: [], ...(model.kind === 'video' && { videoMode: 't2v' as const }), unbound: noSheet };

  if (model.kind === 'image') {
    if (!takesEdits(model)) return { strategy: 'text', refs: [], unbound: cast.map((c) => c.name) };
    const a = allocateReferences(shot, withSheet, cap(model.maxInputImages));
    return { strategy: 'edit', refs: a.refs, unbound: [...noSheet, ...a.unbound] };
  }

  const keyframe = (input.keyframeModels ?? []).find(takesEdits);
  const animates = model.operations.includes('i2v');
  if (takesRefs(model)) {
    const slots = cap(model.maxReferenceImages);
    // Too few slots for the cast while a keyframe could hold them all: chain instead.
    if (slots < withSheet.length && animates && keyframe && capKeyframe(keyframe.maxInputImages) > slots) {
      const a = allocateReferences(shot, withSheet, capKeyframe(keyframe.maxInputImages));
      return { strategy: 'chain', refs: a.refs, keyframeModel: keyframe.id, videoMode: 'i2v', unbound: [...noSheet, ...a.unbound] };
    }
    const a = allocateReferences(shot, withSheet, slots);
    return { strategy: 'refs', refs: a.refs, videoMode: 'refs', unbound: [...noSheet, ...a.unbound] };
  }
  if (animates && keyframe) {
    const a = allocateReferences(shot, withSheet, capKeyframe(keyframe.maxInputImages));
    return { strategy: 'chain', refs: a.refs, keyframeModel: keyframe.id, videoMode: 'i2v', unbound: [...noSheet, ...a.unbound] };
  }
  return { strategy: 'text', refs: [], videoMode: 't2v', unbound: cast.map((c) => c.name) };
}

/** Image models that take reference pictures, cheapest first by `cost` (the chain's keyframe candidates). */
export function referenceImageModels<T extends RefModel>(models: readonly T[], cost: (m: T) => number | null): T[] {
  return models
    .filter(takesEdits)
    .map((m) => ({ m, c: cost(m) }))
    .filter((x): x is { m: T; c: number } => x.c !== null)
    .sort((a, b) => a.c - b.c)
    .map((x) => x.m);
}
