import { useSyncExternalStore } from 'react';
import type { AssetPick, PickKind } from './types';

/**
 * Uploads this tab finished that the server may not list yet. The asset list
 * (GraphQL `assets`) shows a new upload only once its media processing has
 * stored it, a few seconds after the transfer completes, so a picker opened in
 * that window would show "My assets" without it. Finished uploads are kept
 * here and merged into the list until the server lists them (or the grace
 * period ends), and the list refetches while any is still missing.
 */
export const UPLOAD_LISTING_GRACE_MS = 2 * 60_000;

interface Entry {
  pick: AssetPick;
  at: number;
}

let entries: Entry[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Records a finished upload (newest first; one entry per asset). */
export function noteUploadedAsset(pick: AssetPick, now = Date.now()): void {
  entries = [{ pick, at: now }, ...entries.filter((e) => e.pick.assetId !== pick.assetId)];
  emit();
}

/** Uploads still inside the grace period, newest first. */
export function uploadedAssets(now = Date.now()): AssetPick[] {
  return entries.filter((e) => now - e.at < UPLOAD_LISTING_GRACE_MS).map((e) => e.pick);
}

/** Forgets uploads the server lists now, and expired ones. */
export function pruneUploaded(listedAssetIds: Iterable<string>, now = Date.now()): void {
  const listed = new Set(listedAssetIds);
  const next = entries.filter((e) => !listed.has(e.pick.assetId) && now - e.at < UPLOAD_LISTING_GRACE_MS);
  if (next.length === entries.length) return;
  entries = next;
  emit();
}

/** Test helper: forget everything. */
export function resetUploaded(): void {
  entries = [];
  emit();
}

/**
 * The fetched "My assets" list with the finished uploads it does not list yet
 * in front, filtered like the list (kind chip and search).
 */
export function mergeUploaded(fetched: readonly AssetPick[], uploaded: readonly AssetPick[], kind: PickKind | 'all', q: string): AssetPick[] {
  const have = new Set(fetched.map((p) => p.assetId));
  const needle = q.trim().toLowerCase();
  const extra = uploaded.filter(
    (p) => !have.has(p.assetId) && (kind === 'all' ? p.kind !== 'character' : p.kind === kind) && (!needle || p.name.toLowerCase().includes(needle)),
  );
  return extra.length ? [...extra, ...fetched] : [...fetched];
}

let snapshot: AssetPick[] = [];
let snapshotOf: Entry[] | null = null;
function read(): AssetPick[] {
  if (snapshotOf !== entries) {
    snapshotOf = entries;
    snapshot = uploadedAssets();
  }
  return snapshot;
}

export function useUploadedAssets(): AssetPick[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}
