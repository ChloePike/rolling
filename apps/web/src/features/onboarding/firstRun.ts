import type { TemplateCategory, TemplateSummary } from '@/features/templates/types';

/**
 * First-run (D-022): a light three-step start for new trial users, skippable
 * and remembered per user in this browser (`rolling.firstRun.<userId>`).
 */
export type MakeKind = 'ads' | 'drama' | 'talking' | 'social';

export const MAKE_KINDS: readonly MakeKind[] = ['ads', 'drama', 'talking', 'social'];

/** Template categories that fit each kind, best first. */
const CATEGORIES: Record<MakeKind, readonly TemplateCategory[]> = {
  ads: ['product'],
  drama: ['drama', 'comic'],
  talking: ['talking', 'explainer'],
  social: ['holiday', 'outfit', 'venue'],
};

/** Up to `n` templates for the kind (featured first), never mature (template covers never are, D-005). */
export function templatesFor(kind: MakeKind, all: readonly TemplateSummary[], n = 3): TemplateSummary[] {
  const cats = CATEGORIES[kind];
  return all
    .filter((t) => cats.includes(t.category))
    .sort((a, b) => Number(!!b.featured) - Number(!!a.featured) || cats.indexOf(a.category) - cats.indexOf(b.category) || b.uses - a.uses)
    .slice(0, n);
}

const key = (userId: string) => `rolling.firstRun.${userId}`;

export type FirstRunState = 'done' | 'skipped';

export function firstRunState(userId: string): FirstRunState | null {
  try {
    const v = window.localStorage.getItem(key(userId));
    return v === 'done' || v === 'skipped' ? v : null;
  } catch {
    // Storage unavailable: do not nag on every visit.
    return 'skipped';
  }
}

export function rememberFirstRun(userId: string, state: FirstRunState): void {
  try {
    window.localStorage.setItem(key(userId), state);
  } catch {
    /* Storage unavailable. */
  }
}
