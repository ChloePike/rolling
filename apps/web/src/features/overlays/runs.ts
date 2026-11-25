/**
 * Runs client (docs/api.md → Runs (M4)) for tool pages, Home, Activity and the
 * canvas history drawer. The canvas quotes its graph in `features/canvas/api`;
 * this file covers `promptSpec` quotes, starting/cancelling runs and the
 * Activity list.
 */
import { apiFetch } from './backend';

export type RunStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'canceled';

export interface RunItemView {
  ref: string;
  nodeId: string | null;
  title: string | null;
  kind: string;
  model: string;
  modelName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled';
  jobId: string | null;
  progress: number | null;
  credits: number;
  spent: number | null;
  refunded: number;
  assetId: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface RunView {
  id: string;
  ref: string;
  name: string;
  source: 'canvas' | 'quickCreate';
  projectId: string | null;
  projectTitle: string | null;
  params: string;
  status: RunStatus;
  progress: number | null;
  credits: number;
  quoted: number;
  spent: number;
  refunded: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  items: RunItemView[];
}

export interface ActivityStats {
  usedThisMonth: number;
  usedLastMonth: number;
  running: number;
  successRate: number | null;
  runsLast7Days: number;
  refundedThisMonth: number;
}

export interface RunsPage {
  stats: ActivityStats;
  runs: RunView[];
  nextCursor: string | null;
}

export interface RunsFilter {
  status?: RunStatus;
  projectId?: string;
  model?: string;
  from?: number;
  to?: number;
  first?: number;
  after?: string | null;
}

/** `GET /api/runs` (Activity), newest first. */
export function listRuns(filter: RunsFilter = {}, signal?: AbortSignal): Promise<RunsPage> {
  return apiFetch<RunsPage>('/runs', { query: { ...filter }, signal });
}

/** The run with `runId` from the newest page (there is no single-run read; runs are listed newest first). */
export async function findRun(runId: string, filter: RunsFilter = {}): Promise<RunView | null> {
  const page = await listRuns({ first: 30, ...filter });
  return page.runs.find((r) => r.id === runId) ?? null;
}

export async function cancelRun(runId: string): Promise<{ runId: string; refunded: number; canceled: number }> {
  return apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} });
}

/** `PromptSpec` (tool pages, Home generations). `model` is an id, a display name or `auto`. */
export interface PromptSpec {
  kind: 'image' | 'video';
  model?: string;
  prompt?: string;
  title?: string;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  n?: number;
  negativePrompt?: string;
  seed?: number;
  mature?: boolean;
  refsMode?: boolean;
  inputs?: { firstFrameAssetId?: string; lastFrameAssetId?: string; referenceAssetIds?: string[]; inputAssetIds?: string[]; audioAssetId?: string };
}

export interface SpecQuote {
  quoteId: string | null;
  items: Array<{
    ref: string;
    title: string;
    kind: string;
    action: 'run' | 'reuse' | 'blocked' | 'none' | 'bypassed';
    model: string | null;
    modelName: string | null;
    credits: number;
    code?: string;
    reason?: string;
    lowestPlan?: 'starter' | 'plus' | 'pro' | null;
    autoVia?: 'classifier' | 'fallback' | 'single';
  }>;
  total: number;
  balance: number;
  balanceAfter: number;
  expiresAt: number | null;
  confirmThreshold: number;
  needsConfirm: boolean;
}

export function quoteSpec(promptSpec: PromptSpec, projectId?: string): Promise<SpecQuote> {
  return apiFetch<SpecQuote>('/runs/quote', { method: 'POST', body: projectId ? { promptSpec, projectId } : { promptSpec } });
}

export function startQuote(quoteId: string, options?: { forceFailure?: true }): Promise<{ runId: string; status: string }> {
  return apiFetch('/runs', { method: 'POST', body: options?.forceFailure ? { quoteId, options } : { quoteId } });
}

/** True once the run will not change any more. */
export function runFinished(r: Pick<RunView, 'status'>): boolean {
  return r.status === 'done' || r.status === 'partial' || r.status === 'failed' || r.status === 'canceled';
}
