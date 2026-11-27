import { useCallback, useEffect, useState } from 'react';
import { AUTO_BUDGET, autoBudgetCredits } from '@rolling/core/pricing/config';
import { setPref, usePrefs, type AgentModePref } from '@/lib/prefs';

/**
 * D-021 agent mode of one surface (`home`, or `canvas:<projectId>`): remembered per
 * project in this browser, else the thread's own mode, else the Preferences default.
 * Auto's per-turn budget is a preference (`autoBudget`, default the confirm threshold).
 */
export type AgentMode = AgentModePref;
export const AGENT_MODES: readonly AgentMode[] = ['read', 'edit', 'auto'];

const key = (scope: string) => `rolling.agent.mode.${scope}`;

export function readScopeMode(scope: string): AgentMode | null {
  try {
    const v = localStorage.getItem(key(scope));
    return v && (AGENT_MODES as readonly string[]).includes(v) ? (v as AgentMode) : null;
  } catch {
    return null;
  }
}

export function writeScopeMode(scope: string, mode: AgentMode) {
  try {
    localStorage.setItem(key(scope), mode);
  } catch {
    /* Storage unavailable: the default applies next time. */
  }
}

/** The budget choices the switch offers, with the user's current value and threshold included, ascending. */
export function budgetChoices(current: number, threshold: number): number[] {
  return [...new Set([...AUTO_BUDGET.choices, threshold, current])].filter((n) => n >= 0 && n <= AUTO_BUDGET.max).sort((a, b) => a - b);
}

export interface AgentModeState {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  /** A thread restored from the server: its mode applies when this browser has none for the scope. */
  adopt: (mode: AgentMode | null | undefined) => void;
  budget: number;
  /** null follows the confirm threshold. */
  setBudget: (credits: number | null) => void;
  threshold: number;
}

export function useAgentMode(scope: string): AgentModeState {
  const prefs = usePrefs();
  const [mode, setModeState] = useState<AgentMode>(() => readScopeMode(scope) ?? prefs.agentMode);
  useEffect(() => {
    setModeState(readScopeMode(scope) ?? prefs.agentMode);
    // A new scope (another project) reads its own record; the default only when it has none.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const setMode = useCallback(
    (m: AgentMode) => {
      setModeState(m);
      writeScopeMode(scope, m);
    },
    [scope],
  );
  const adopt = useCallback(
    (m: AgentMode | null | undefined) => {
      if (m && !readScopeMode(scope)) setModeState(m);
    },
    [scope],
  );
  const budget = autoBudgetCredits(prefs.autoBudget, prefs.confirmThreshold);
  const setBudget = useCallback((credits: number | null) => setPref('autoBudget', credits), []);
  return { mode, setMode, adopt, budget, setBudget, threshold: prefs.confirmThreshold };
}
