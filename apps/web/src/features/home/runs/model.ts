import { chainOf, isFailedRun, type ChainStepName, type PromptSpec, type RunView } from '@/features/overlays/runs';

/**
 * Home run cards: one card per generation sent from the Home prompt box
 * (Image, Video, Avatar). Pure logic, unit tested in `model.test.ts`; the hook
 * (`useHomeRuns.ts`) follows real runs over the user socket and the runs API.
 */

export type CardStatus = 'starting' | 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface HomeRunCard {
  /** Local key: stable from the send, before the server hands out a run id. */
  key: string;
  /** `run_…` once credits are held. */
  runId: string | null;
  kind: 'image' | 'video';
  /** The Home mode it was sent from (Avatar runs are videos too). */
  mode?: 'image' | 'video' | 'avatar';
  prompt: string;
  title: string;
  modelName: string;
  /** e.g. "Seedance 2.0 Fast · 9:16 · 720p · 10s". */
  meta: string;
  /** CSS aspect ratio of the result, e.g. "9/16". */
  aspect: string;
  params: Array<{ label: string; value: string }>;
  /** What generated it (real mode), so Run again sends the same request. */
  spec?: PromptSpec;
  /** Credits held for the run (the quote), then charged once it settles. */
  credits: number;
  status: CardStatus;
  /** 0..1 while generating, when the provider reports it; null otherwise (never a guess in real mode). */
  progress: number | null;
  createdAt: number;
  finishedAt: number | null;
  assetIds: string[];
  spent: number;
  refunded: number;
  error: string | null;
  /** The server says the failed or canceled items can be quoted again. */
  retryable: boolean;
  /**
   * D-005 mature text-to-video chain: one generation in two steps. `step` is
   * the one running (null once it ended); `keyframeAssetId` the first frame,
   * shown when the animation failed.
   */
  chain?: { step: ChainStepName | null; keyframeAssetId: string | null };
}

/** Cards kept per user and workspace in this browser (newest first). */
export const MAX_CARDS = 12;

export function isActive(c: Pick<HomeRunCard, 'status'>): boolean {
  return c.status === 'starting' || c.status === 'queued' || c.status === 'running';
}

/** Server run status → card status. A partial run (some items succeeded) shows what it made. */
export function cardStatus(s: RunView['status']): CardStatus {
  switch (s) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
    case 'partial':
      return 'done';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
  }
}

/** The card after a fresh `GET /api/runs/:id`. */
export function applyRunView(card: HomeRunCard, view: RunView): HomeRunCard {
  const chain = chainOf(view);
  // A chain whose animation failed is a failed card (the first frame stays visible on it).
  const status = isFailedRun(view) && view.status === 'partial' ? 'failed' : cardStatus(view.status);
  // A chain's first frame is never the card's result (it shows on a failed card through `chain.keyframeAssetId`).
  const assetIds = view.items
    .filter((i) => i.step !== 'keyframe')
    .map((i) => i.assetId)
    .filter((id): id is string => !!id);
  const failedItem = view.items.find((i) => i.status === 'failed' && i.error);
  const progress = status === 'running' ? (view.progress ?? card.progress) : status === 'done' ? 1 : null;
  return {
    ...card,
    runId: view.id,
    status,
    progress,
    credits: view.credits || view.quoted || card.credits,
    spent: view.spent,
    refunded: view.refunded,
    assetIds: assetIds.length ? assetIds : card.assetIds,
    error: status === 'failed' ? (failedItem?.error ?? view.error ?? card.error) : null,
    finishedAt: view.finishedAt ?? (isActive({ status }) ? null : (card.finishedAt ?? Date.now())),
    retryable: view.retryable ?? (status === 'failed' || status === 'canceled'),
    ...(chain && { chain: { step: chain.current, keyframeAssetId: chain.keyframeAssetId } }),
  };
}

/** A live `activity.updated { runId, progress }` for an active card: moves it to generating. */
export function applyProgress(card: HomeRunCard, progress: number): HomeRunCard {
  if (!isActive(card)) return card;
  const p = Math.max(0, Math.min(0.99, progress));
  return { ...card, status: 'running', progress: Math.max(card.progress ?? 0, p) };
}

/** Typical wait in seconds by kind (handoff: “~2 min” for video). */
export function typicalSeconds(kind: HomeRunCard['kind']): number {
  return kind === 'video' ? 120 : 20;
}

/**
 * Seconds left, or null when there is nothing honest to say. With reported
 * progress the rate so far is extrapolated; without it, the typical wait minus
 * the time spent (null once that is used up).
 */
export function remainingSeconds(card: Pick<HomeRunCard, 'kind' | 'progress' | 'status'>, elapsedSec: number): number | null {
  if (!isActive(card)) return null;
  const p = card.progress ?? 0;
  // A few seconds of history before extrapolating: an early jump in progress says little about the rest.
  if (p >= 0.05 && elapsedSec >= 5) return Math.max(1, Math.round((elapsedSec * (1 - p)) / p));
  const left = typicalSeconds(card.kind) - elapsedSec;
  return left > 0 ? Math.round(left) : null;
}

/** `m:ss` for an elapsed time. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Newest first, one card per key and per run id, at most `MAX_CARDS`. */
export function upsertCard(list: HomeRunCard[], card: HomeRunCard): HomeRunCard[] {
  const rest = list.filter((c) => c.key !== card.key && !(card.runId && c.runId === card.runId));
  const at = list.findIndex((c) => c.key === card.key || (!!card.runId && c.runId === card.runId));
  const next = at === -1 ? [card, ...rest] : [...rest.slice(0, at), card, ...rest.slice(at)];
  return next.slice(0, MAX_CARDS);
}

/** Parses stored cards, dropping anything malformed. Cards still `starting` never got a run: they are dropped. */
export function parseStored(raw: string | null): HomeRunCard[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c): c is HomeRunCard => !!c && typeof c === 'object' && typeof (c as HomeRunCard).key === 'string' && typeof (c as HomeRunCard).status === 'string')
      .filter((c) => c.status !== 'starting')
      .map((c) => ({ ...c, assetIds: Array.isArray(c.assetIds) ? c.assetIds : [], params: Array.isArray(c.params) ? c.params : [] }))
      .slice(0, MAX_CARDS);
  } catch {
    return [];
  }
}
