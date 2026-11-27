import { DEFAULT_CONFIRM_THRESHOLD_CREDITS, type PlanId } from '@rolling/core/pricing/config';
import type { IntlShape } from 'react-intl';
import { planLockInfo } from '@/features/overlays';
import { useMemo } from 'react';
import { useModels, type CatalogModel } from '@/lib/models';
import { usePref } from '@/lib/prefs';
import type { GraphNode } from '@rolling/core/graph';
import { shotOfParams } from '@rolling/core/prompting/shot';

/**
 * Node prices and plan caps (D-006). Cost chips come from the per-resolution
 * credits of the synced catalog (`useModels`). When the catalog is not
 * available (no API in dev and e2e, first offline start) the node's mock
 * estimate `params.runCost` is used instead.
 */

export const CONFIRM_THRESHOLD = DEFAULT_CONFIRM_THRESHOLD_CREDITS;

/** Resolutions offered when the catalog has none for a model. */
const DEFAULT_RESOLUTIONS = { video: ['480p', '720p', '1080p', '4K'], image: ['1K', '2K', '4K'] } as const;

export type MediaKind = 'video' | 'image';

export function mediaKind(node: GraphNode): MediaKind | null {
  return node.kind === 'video' ? 'video' : node.kind === 'image' ? 'image' : null;
}

export function findModel(models: CatalogModel[] | undefined, node: GraphNode): CatalogModel | undefined {
  const name = node.params.model;
  if (!models || typeof name !== 'string') return undefined;
  return models.find((m) => m.id === name || m.name === name);
}

/**
 * The node's "Enhance prompt" toggle (D-020): its own choice, else off for agent-planned
 * nodes and the Preferences default for the rest.
 */
export function nodeEnhanceOn(node: GraphNode, pref: boolean): boolean {
  if (typeof node.params.promptExpand === 'boolean') return node.params.promptExpand;
  return node.createdBy === 'agent' ? false : pref;
}

/**
 * Whether a run of `node` on `model` is priced with the prompt rewrite, as the quote prices it:
 * the toggle is on, the model takes the expansion while it is available, and the prompt is the
 * user's own (a prompt composed from a shot is never expanded).
 */
export function nodeExpands(node: GraphNode, model: CatalogModel | undefined, pref: boolean): boolean {
  if (!model || model.promptExpand !== 'available' || !nodeEnhanceOn(node, pref)) return false;
  const kind = mediaKind(node);
  return kind !== null && shotOfParams(kind, node.params) === null;
}

/**
 * Credits for one run of `node` at its resolution and length, from the catalog points.
 * `enhance`: price it with the prompt rewrite's most (the points' `enhanced`, D-020).
 */
export function catalogCredits(model: CatalogModel, node: GraphNode, opts: { enhance?: boolean } = {}): number | undefined {
  const res = typeof node.params.resolution === 'string' ? node.params.resolution : model.defaultResolution;
  const seconds = typeof node.params.length === 'number' ? node.params.length : typeof node.params.seconds === 'number' ? node.params.seconds : model.defaultSeconds;
  const count = typeof node.params.count === 'number' ? node.params.count : 1;
  const atRes = model.credits
    .filter((c) => c.resolution === res || c.resolution === null)
    .map((c) => (opts.enhance && typeof c.enhanced === 'number' ? { ...c, credits: c.enhanced } : c));
  if (!atRes.length) return undefined;
  if (model.kind === 'image' || seconds === null) return atRes[0]!.credits * count;
  const exact = atRes.find((c) => c.seconds === seconds);
  if (exact) return exact.credits * count;
  const timed = atRes.filter((c) => c.seconds);
  if (!timed.length) return atRes[0]!.credits * count;
  const near = timed.reduce((a, b) => (Math.abs((b.seconds ?? 0) - seconds) < Math.abs((a.seconds ?? 0) - seconds) ? b : a));
  return Math.ceil((near.credits / near.seconds!) * seconds) * count;
}

/** Resolutions for the node's model; `lock` (from the shared overlays) is set for those above the plan's cap. */
export function resolutionOptions(intl: IntlShape, model: CatalogModel | undefined, kind: MediaKind, plan: PlanId) {
  const list = model?.resolutions.length ? model.resolutions : DEFAULT_RESOLUTIONS[kind];
  return list.map((value) => ({ value, lock: planLockInfo(intl, plan, kind, value) }));
}

/** Adds the catalog price (or the mock estimate) to every node that can run. */
export function usePricedNodes(nodes: GraphNode[]): { nodes: GraphNode[]; models: CatalogModel[] | undefined } {
  const { data: models } = useModels();
  const enhancePref = usePref('enhancePrompt');
  const priced = useMemo(
    () =>
      nodes.map((n) => {
        const model = findModel(models, n);
        const credits = model ? catalogCredits(model, n, { enhance: nodeExpands(n, model, enhancePref) }) : undefined;
        if (credits !== undefined) return { ...n, cost: credits };
        if (n.cost !== undefined || typeof n.params.runCost !== 'number') return n;
        return { ...n, cost: n.params.runCost };
      }),
    [nodes, models, enhancePref],
  );
  return { nodes: priced, models };
}

/** `"9:16 · 720p · 5s"` from the node's params (ratio, resolution, requested length). */
export function formatLabel(node: GraphNode): string {
  const p = node.params;
  const len = typeof p.length === 'number' ? p.length : typeof p.seconds === 'number' ? p.seconds : null;
  const parts = [p.ratio, p.resolution, node.kind === 'video' && len !== null ? `${len}s` : null];
  return parts.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ');
}
