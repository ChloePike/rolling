import type { AgentMode, TurnSettings } from '@/features/overlays/agent';

/**
 * D-039: a brief sent from Home in Agent mode starts on its own canvas. Home makes
 * the project, saves the brief and the prompt box's choices here and opens the
 * canvas; the canvas agent panel takes it once and sends it as the first message
 * of that project's thread. Kept in sessionStorage so a reload during the hand-off
 * still sends it, and taken (cleared) on send so it never sends twice.
 */
export interface AgentHandoff {
  projectId: string;
  /** The brief as typed (or the skill's name when only a skill was picked). */
  text: string;
  /** `@` references and attachments: asset ids, or upload ids still in flight (resolved on send). */
  refs: string[];
  /** Their names, shown under the brief in the conversation. */
  refNames: string[];
  /** Skill chip label as the canvas panel shows it (`/TV ad`), or null. */
  skill: string | null;
  /** Public agent LLM id, or null for the default. */
  llm: string | null;
  /** Video model (null = Auto), ratio and total length from the Home pills. */
  settings: TurnSettings;
  /** D-021 mode and, in Auto, the per-turn budget. */
  mode: AgentMode;
  autoBudget?: number;
  at: number;
}

const KEY = 'rolling.agent.handoff';
/** Projects that started from a Home brief in this tab (mock mode opens them empty). */
const FROM_HOME_KEY = 'rolling.agent.fromHome';
/** A hand-off older than this is dropped (the canvas never opened). */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(): AgentHandoff | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as AgentHandoff;
    if (typeof h?.projectId !== 'string' || typeof h.text !== 'string' || typeof h.at !== 'number') return null;
    if (Date.now() - h.at > HANDOFF_MAX_AGE_MS) {
      s.removeItem(KEY);
      return null;
    }
    return h;
  } catch {
    return null;
  }
}

/** Home: keeps the brief for the project it just made (one hand-off at a time). */
export function saveHandoff(h: Omit<AgentHandoff, 'at'>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify({ ...h, at: Date.now() } satisfies AgentHandoff));
    const ids = fromHomeIds();
    if (!ids.includes(h.projectId)) s.setItem(FROM_HOME_KEY, JSON.stringify([h.projectId, ...ids].slice(0, 20)));
  } catch {
    /* Storage unavailable: the canvas opens without the brief. */
  }
}

/** The hand-off waiting for `projectId`, without taking it. */
export function peekHandoff(projectId: string | undefined): AgentHandoff | null {
  const h = read();
  return h && projectId && h.projectId === projectId ? h : null;
}

/** Takes (and clears) the hand-off for `projectId`; null when none waits for it. */
export function takeHandoff(projectId: string | undefined): AgentHandoff | null {
  const h = peekHandoff(projectId);
  if (h) {
    try {
      storage()?.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
  return h;
}

function fromHomeIds(): string[] {
  try {
    const v = JSON.parse(storage()?.getItem(FROM_HOME_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The project started from a Home brief in this tab (mock mode: an empty canvas, no demo graph or conversation). */
export function startedFromHome(projectId: string | undefined): boolean {
  return !!projectId && fromHomeIds().includes(projectId);
}
