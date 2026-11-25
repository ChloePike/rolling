/** Activity rows, shaped like `GET /api/runs` items (docs/api.md, Runs). */
export type RunStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'review' | 'canceled';
export type RunSource = 'canvas' | 'quickCreate' | 'remix' | 'avatar' | 'characters';
export type RunAction = 'view' | 'retry' | 'cancel' | 'locate';

export interface RunRow {
  id: string;
  /** Short task reference shown under the name, e.g. `T-90412`. */
  ref: string;
  name: string;
  source: RunSource;
  projectTitle?: string;
  /** Model and settings summary, e.g. `Seedance 2.5 · 720p · 5s`. */
  params: string;
  status: RunStatus;
  /** 0..1, only while running. */
  progress?: number;
  /** Quoted credits for queued/running; charged credits otherwise. */
  credits: number;
  refunded: number;
  /** Failure reason shown under failed rows. */
  error?: string;
  minutesAgo: number;
  /** Real mode: where the run belongs, its first result and the canvas nodes to retry. */
  projectId?: string | null;
  assetId?: string | null;
  mediaKind?: 'video' | 'image';
  failedNodeIds?: string[];
}

export interface ActivityStats {
  usedThisMonth: number;
  usedChange: number;
  running: number;
  runningEtaMinutes: number;
  successRate: number;
  runsLast7Days: number;
  refunded: number;
}

export interface ActivityData {
  stats: ActivityStats;
  runs: RunRow[];
}
