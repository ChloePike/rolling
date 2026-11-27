import type { ToolIconName } from './shared/icons';

/** Shapes of the tool feed, shaped like `GET /api/runs` rows in docs/api.md (mocked until M2). */
export type StepState = 'done' | 'now' | 'todo';

export interface RunStep {
  label: string;
  state: StepState;
}

export interface MediaTile {
  label?: string;
  tone: string;
  /** Real mode: the result media (signed redirect). */
  src?: string;
}

export interface MediaRun {
  kind: 'media';
  id: string;
  /** CSS aspect ratio, e.g. `9/16`. */
  aspect: string;
  tiles: MediaTile[];
  prompt: string;
  tags: string[];
  /** 0–100 while running; undefined when done. 0 while running means no progress reported (the card shows the elapsed time). */
  progress?: number;
  /** Epoch ms the run started, for the elapsed time while no progress is reported. */
  startedAt?: number;
  video: boolean;
  /** Seconds, for the duration badge. */
  durationSec?: number;
  steps?: RunStep[];
  /** Minutes since the run finished. */
  finishedAgoMin?: number;
  actions: ToolIconName[];
  /** Quoted credits held for a run started in this session. */
  cost?: number;
  /** The run failed; its hold was released (handoff 4: failures refund automatically). */
  failed?: { refunded: number };
  /** Real mode: the API run and its first result asset. */
  runId?: string;
  assetId?: string | null;
  /** D-020: the prompt that rendered when the gateway rewrote it ("Enhanced prompt"). */
  expandedPrompt?: string;
}

export interface DraftLine {
  at: string;
  text: string;
  exact: boolean;
  action: string;
}

export interface ScriptDraft {
  kind: 'draft';
  id: string;
  title: string;
  meta: string;
  lines: DraftLine[];
}

export type FeedItem = MediaRun | ScriptDraft;

export type ToolId = 'quick' | 'remix' | 'avatar' | 'character';
export type PickerKind = 'video' | 'image' | 'avatar';
export type ParamKind = 'video' | 'image';

export interface ComposerPill {
  id: string;
  label: string;
  icon: ToolIconName;
}

export interface ComposerRef {
  badge: string;
  tone: string;
}
