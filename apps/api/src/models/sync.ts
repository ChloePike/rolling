/**
 * Model catalog sync (D-002): fetch Hyperouter `GET /v1/models`, parse it,
 * upsert into D1, delete models absent for more than 24 h, log a diff.
 * Runs from the cron trigger (every 6 hours).
 */
import { MODEL_OVERLAY, mergeModel, parseListing, type ListingModel, type SkippedModel } from "@rolling/core";
import type { NewModelRow } from "@rolling/db/d1";
import { deleteModelsSeenBefore, listModelRows, upsertModels } from "@rolling/db/queries/models";
import { recheckGatewayFeatures } from "./features";

/** Models missing from the listing are kept this long (transient gaps), then deleted. */
export const MODEL_ABSENT_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SyncModelsOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ModelSyncDiff {
  total: number;
  added: string[];
  changed: string[];
  /** Absent from this listing, still within the grace period. */
  missing: string[];
  deleted: string[];
  skipped: SkippedModel[];
  /** Listing fields we could not map, per model (only models that have some). */
  unmapped: Record<string, string[]>;
}

export class ModelSyncError extends Error {
  override readonly name = "ModelSyncError";
}

export function modelRow(model: ListingModel, syncedAt: number): NewModelRow {
  const { price, ...data } = model;
  const merged = mergeModel(model, MODEL_OVERLAY[model.id]);
  return {
    id: model.id,
    kind: model.kind,
    data: JSON.stringify(data),
    price: JSON.stringify(price),
    hidden: merged.hidden,
    mature: merged.mature,
    syncedAt,
  };
}

export async function syncModels(env: Env, opts: SyncModelsOptions = {}): Promise<ModelSyncDiff> {
  const doFetch = opts.fetch ?? fetch;
  const now = (opts.now ?? Date.now)();
  const key = env.HYPEROUTER_API_KEY;
  if (!key) throw new ModelSyncError("HYPEROUTER_API_KEY is not set.");
  const url = `${env.HYPEROUTER_BASE_URL.replace(/\/+$/, "")}/models`;

  const res = await doFetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ModelSyncError(`GET ${url} answered ${res.status}.`);
  }
  const { models, skipped } = parseListing(await res.json());
  // An empty listing is far more likely an outage than a gateway with no models: change nothing.
  if (models.length === 0) throw new ModelSyncError(`Listing parsed to no models (${skipped.length} skipped).`);

  const before = new Map((await listModelRows(env.DB)).map((r) => [r.id, r]));
  const rows = models.map((m) => modelRow(m, now));
  const seen = new Set(rows.map((r) => r.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const row of rows) {
    const prev = before.get(row.id);
    if (!prev) added.push(row.id);
    else if (prev.data !== row.data || prev.price !== row.price || prev.hidden !== row.hidden || prev.mature !== row.mature) {
      changed.push(row.id);
    }
  }
  await upsertModels(env.DB, rows);
  const deleted = await deleteModelsSeenBefore(env.DB, now - MODEL_ABSENT_GRACE_MS);
  const missing = [...before.keys()].filter((id) => !seen.has(id) && !deleted.includes(id)).sort();
  const unmapped = Object.fromEntries(models.filter((m) => m.unmapped.length > 0).map((m) => [m.id, m.unmapped]));

  // D-020: a gateway feature refused a day ago or more is tried again by the next run.
  const rechecked = await recheckGatewayFeatures(env, now).catch((err: unknown) => {
    console.warn(JSON.stringify({ msg: "models: feature recheck failed", error: String(err) }));
    return [] as string[];
  });
  const diff: ModelSyncDiff = { total: models.length, added, changed, missing, deleted, skipped, unmapped };
  console.log(
    JSON.stringify({
      msg: "models: synced",
      total: diff.total,
      added,
      changed,
      missing,
      deleted,
      skipped,
      unmappedModels: Object.keys(unmapped).length,
      promptExpandModels: models.filter((m) => m.params.promptExpand).length,
      ...(rechecked.length > 0 && { rechecked }),
    }),
  );
  return diff;
}
