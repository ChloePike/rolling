/**
 * Runs client (docs/api.md → Runs (M4)) for tool pages, Home, Activity and the
 * canvas history drawer. The canvas quotes its graph in `features/canvas/api`;
 * this file covers `promptSpec` quotes, starting/cancelling runs and the
 * Activity list.
 */
import { apiFetch, isApiError } from './backend';

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
  /** The request it was quoted from: a tool `promptSpec` or a canvas scope (null for old runs). */
  request?: { promptSpec: PromptSpec } | { scope: string; nodeIds?: string[] } | null;
  /** Tool of a spec run (`quick` = image/video); null for canvas runs. */
  tool?: 'quick' | 'remix' | 'avatar' | 'character' | null;
  retryOf?: string | null;
  /** Character runs: the Character saved from the outputs. */
  characterId?: string | null;
  /** Failed, canceled or skipped items can be quoted again (`retryRun`). */
  retryable?: boolean;
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

/** `GET /api/runs/:id`. */
export async function getRun(runId: string, signal?: AbortSignal): Promise<RunView> {
  return (await apiFetch<{ run: RunView }>(`/runs/${encodeURIComponent(runId)}`, { signal })).run;
}

/** The run with `runId` (`GET /api/runs/:id`), or null when it is gone. */
export async function findRun(runId: string, _filter: RunsFilter = {}): Promise<RunView | null> {
  try {
    return await getRun(runId);
  } catch (e) {
    if (isApiError(e, 'NOT_FOUND')) return null;
    throw e;
  }
}

/**
 * `POST /api/runs/:id/retry`: a fresh quote for the failed, canceled and
 * skipped items with the same request. Confirm it like any quote, then
 * `startQuote(quoteId)`.
 */
export function retryRun(runId: string): Promise<SpecQuote & { retryOf: string }> {
  return apiFetch(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST', body: {} });
}

export async function cancelRun(runId: string): Promise<{ runId: string; refunded: number; canceled: number }> {
  return apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} });
}

/**
 * `PromptSpec` (tool pages, Home generations). `model` is an id, a display name or `auto`.
 * `remix`: `inputs.videoAssetId` + `shots`, new looks in `referenceAssetIds`; `avatar`:
 * `inputs.photoAssetId` + an uploaded `audioAssetId`; `character`: `name`, `prompt`, `referenceAssetIds`.
 */
export interface PromptSpec {
  kind: 'image' | 'video' | 'remix' | 'avatar' | 'character';
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
  shots?: Array<{ prompt?: string; seconds?: number; frameAssetId?: string; startSec?: number }>;
  name?: string;
  views?: Array<'body' | 'face'>;
  inputs?: {
    firstFrameAssetId?: string;
    lastFrameAssetId?: string;
    referenceAssetIds?: string[];
    inputAssetIds?: string[];
    audioAssetId?: string;
    photoAssetId?: string;
    videoAssetId?: string;
  };
}

export interface SpecQuote {
  quoteId: string | null;
  items: Array<{
    ref: string;
    nodeId?: string | null;
    title: string;
    kind: string;
    action: 'run' | 'reuse' | 'blocked' | 'none' | 'bypassed';
    model: string | null;
    modelName: string | null;
    credits: number;
    code?: string;
    reason?: string;
    lowestPlan?: 'starter' | 'plus' | 'pro' | null;
    /** `MATURE_REQUIRED`: why the caller has no mature access (D-005); `no_plan` opens the upgrade modal with reason `mature`. */
    matureAccess?: 'no_plan' | 'preference_off' | 'workspace_off';
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

/**
 * Resolves every input of a spec that may still be an upload id (`upl_…`, handed
 * out before the upload finished) to its asset id: inputs and Remix shot frames.
 */
export async function resolveSpecAssets(spec: PromptSpec, resolve: (id: string) => Promise<string>): Promise<PromptSpec> {
  const i = spec.inputs;
  const one = async (id?: string) => (id ? resolve(id) : undefined);
  const many = async (ids?: string[]) => (ids ? Promise.all(ids.map((id) => resolve(id))) : undefined);
  const out: PromptSpec = { ...spec };
  if (i) {
    const inputs: NonNullable<PromptSpec['inputs']> = {};
    for (const k of ['firstFrameAssetId', 'lastFrameAssetId', 'audioAssetId', 'photoAssetId', 'videoAssetId'] as const) {
      const v = await one(i[k]);
      if (v) inputs[k] = v;
    }
    for (const k of ['referenceAssetIds', 'inputAssetIds'] as const) {
      const v = await many(i[k]);
      if (v) inputs[k] = v;
    }
    out.inputs = inputs;
  }
  if (spec.shots) out.shots = await Promise.all(spec.shots.map(async (s) => (s.frameAssetId ? { ...s, frameAssetId: await resolve(s.frameAssetId) } : s)));
  return out;
}
