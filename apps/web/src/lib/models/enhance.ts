import { useEffect, useState } from 'react';
import { usePref } from '@/lib/prefs';
import type { CatalogModel } from './index';

/**
 * D-020 "Enhance prompt": whether the run's model takes the gateway's prompt
 * expansion. `available`: show the toggle; `unavailable`: show it disabled
 * with "Not available yet" (the gateway has not enabled it for us); null: hide it.
 */
export type EnhanceState = 'available' | 'unavailable' | null;

/** State for one model, or for Auto over its candidates (available when any of them takes it). */
export function enhanceStateOf(models: ReadonlyArray<Pick<CatalogModel, 'promptExpand'> | undefined>): EnhanceState {
  const states = models.map((m) => m?.promptExpand ?? null);
  if (states.includes('available')) return 'available';
  if (states.includes('unavailable')) return 'unavailable';
  return null;
}

export interface EnhancePrompt {
  state: EnhanceState;
  /** The run's choice: the user's change for this run, else the Preferences default. */
  on: boolean;
  set: (on: boolean) => void;
  /** What the run's `promptSpec.promptExpand` carries (absent while the toggle is hidden or unavailable). */
  spec: { promptExpand?: boolean };
}

/** The run's choice: this run's change, else the Preferences default; the spec carries it only while the toggle is usable. */
export function enhanceChoice(state: EnhanceState, override: boolean | null, pref: boolean): Pick<EnhancePrompt, 'on' | 'spec'> {
  const on = override ?? pref;
  return { on, spec: state === 'available' ? { promptExpand: on } : {} };
}

/** Per-run "Enhance prompt" toggle that starts from Preferences → "Enhance prompt" and follows it until the user changes it here. */
export function useEnhancePrompt(state: EnhanceState): EnhancePrompt {
  const pref = usePref('enhancePrompt');
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [pref]);
  return { state, set: setOverride, ...enhanceChoice(state, override, pref) };
}
