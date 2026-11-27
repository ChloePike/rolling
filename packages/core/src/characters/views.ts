/**
 * Which sheet view a shot should be drawn from (D-032): the view whose framing
 * and angle are closest to the shot's, so the model copies a face it can see
 * the way the shot shows it. Close-ups take the face (or the expression the
 * shot asks for), wide shots the full body (the outfit), side angles and
 * moving cameras the profile or 3/4 view.
 */
import type { ShotCamera, ShotDialogue } from '../prompting/shot';
import type { SheetView } from './sheet';

export interface ViewChoiceInput {
  camera?: ShotCamera;
  /** Action and dialogue tone, read for an expression ("she laughs", tone "angry"). */
  action?: string;
  dialogue?: readonly Pick<ShotDialogue, 'tone' | 'line'>[];
}

const EXPRESSION_CUES: ReadonlyArray<[SheetView, RegExp]> = [
  ['expression_smile', /\b(smil\w*|laugh\w*|grin\w*|giggl\w*|happy|joy\w*|cheer\w*|delight\w*)\b/i],
  ['expression_surprised', /\b(surpris\w*|shock\w*|gasp\w*|astonish\w*|stunned|amazed)\b/i],
  ['expression_sad', /\b(sad\w*|cry\w*|cries|tear\w*|sob\w*|grief|griev\w*|upset|mourn\w*)\b/i],
  ['expression_angry', /\b(angr\w*|furious|rage\w*|shout\w*|yell\w*|scowl\w*|glare\w*)\b/i],
  ['expression_serious', /\b(serious|stern|focus\w*|determined|grim|solemn|frown\w*)\b/i],
];

/** The expression view a shot's action or line tone asks for, if any. */
export function expressionCue(input: Pick<ViewChoiceInput, 'action' | 'dialogue'>): SheetView | null {
  const text = [input.action ?? '', ...(input.dialogue ?? []).map((d) => d.tone ?? '')].join(' ');
  for (const [view, re] of EXPRESSION_CUES) if (re.test(text)) return view;
  return null;
}

/**
 * Sheet views for a shot, best first, from those available. The first is the
 * primary reference; the rest are fallbacks or a second picture when the
 * model takes more than one per character (face detail for a wide shot, the
 * outfit for a close-up).
 */
export function rankSheetViews(input: ViewChoiceInput, available: readonly SheetView[]): SheetView[] {
  const has = new Set(available);
  const size = input.camera?.size;
  const angle = input.camera?.angle;
  const move = input.camera?.move;
  const order: SheetView[] = [];
  const push = (...views: SheetView[]) => views.forEach((v) => order.push(v));
  const close = size === 'close_up' || size === 'extreme_close_up';
  const medium = size === 'medium' || size === 'medium_close_up';
  const wide = size === 'full' || size === 'wide' || size === 'extreme_wide';
  const side = angle === 'over_the_shoulder' || move === 'truck_left' || move === 'truck_right' || move === 'tracking';
  if (close) {
    const cue = expressionCue(input);
    if (cue) push(cue);
    if (side) push('profile', 'three_quarter');
    push('front', 'three_quarter', 'profile', 'full_body');
  } else if (medium) {
    if (side) push('profile');
    push('three_quarter', 'front');
    const cue = expressionCue(input);
    if (cue) push(cue);
    push('full_body', 'profile');
  } else if (wide || angle === 'aerial' || angle === 'overhead' || angle === 'high_angle') {
    push('full_body', 'three_quarter', 'front', 'profile');
  } else if (side || move === 'orbit') {
    push('three_quarter', 'profile', 'full_body', 'front');
  } else {
    // No framing given: the full body carries the face and the outfit.
    push('full_body', 'front', 'three_quarter', 'profile');
  }
  // Any remaining views (expressions) last, in sheet order.
  for (const v of available) push(v);
  const seen = new Set<SheetView>();
  return order.filter((v) => has.has(v) && !seen.has(v) && (seen.add(v), true));
}

/** The best matching view, or null when the sheet has none. */
export function pickSheetView(input: ViewChoiceInput, available: readonly SheetView[]): SheetView | null {
  return rankSheetViews(input, available)[0] ?? null;
}

/** A face view and a body view complement each other: the second picture for a character, when there is room. */
export function companionView(primary: SheetView, ranked: readonly SheetView[]): SheetView | null {
  const faceViews = new Set<SheetView>(['front', 'profile', 'expression_smile', 'expression_serious', 'expression_surprised', 'expression_sad', 'expression_angry']);
  const wantsBody = faceViews.has(primary);
  const pick = ranked.find((v) => v !== primary && (wantsBody ? v === 'full_body' || v === 'three_quarter' : faceViews.has(v)));
  return pick ?? null;
}
