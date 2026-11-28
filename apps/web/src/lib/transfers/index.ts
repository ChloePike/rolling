/**
 * Transfer manager (D-011): uploads and downloads through one shared queue.
 *
 *   const { items, rejected } = transfers.uploadFiles(files, { purpose: 'reference' });
 *   const { assetId } = await items[0].done;
 *   await transfers.download(url, { filename, refreshUrl });
 *   const blob = await transfers.fetchBlob(url);
 */
import { useSyncExternalStore } from 'react';
import { TransfersClient } from './client';
import type { QueueSnapshot } from './types';
import { addBusyCheck } from '@/lib/pwa/register';

export const transfers = new TransfersClient();

// Silent app updates wait while an upload or download is in flight (a reload would cut it).
const ACTIVE: ReadonlySet<string> = new Set(['queued', 'preparing', 'running', 'retrying', 'completing']);
addBusyCheck(() => transfers.getSnapshot().items.some((i) => ACTIVE.has(i.status)));

export const uploadFiles = transfers.uploadFiles.bind(transfers);
export const download = transfers.download.bind(transfers);
export const fetchBlob = transfers.fetchBlob.bind(transfers);
export const resolveAssetId = transfers.resolveAssetId.bind(transfers);

/** Live queue state shared by every tab (shared mode) or this tab (fallbacks). */
export function useTransfers(): QueueSnapshot {
  return useSyncExternalStore(transfers.subscribe, transfers.getSnapshot, transfers.getSnapshot);
}

export { TransfersClient } from './client';
export type { UploadHandle, UploadOptions, UploadResult, DownloadOptions, FetchBlobOptions, Rejected } from './client';
export { DEFAULT_CONFIG, UPLOAD_LIMITS, validateUpload, contentTypeOf, resolveConfig, type TransfersConfig, type ConcurrencyConfig } from './config';
export type { TransferItem, TransferStatus, TransferEvent, QueueSnapshot, Purpose, Priority, TransportMode } from './types';

// Tests and debugging: `__ROLLING_TRANSFERS__ = { expose: true }` puts the client on window.
if (globalThis.__ROLLING_TRANSFERS__?.expose) (globalThis as { __rollingTransfers?: TransfersClient }).__rollingTransfers = transfers;
