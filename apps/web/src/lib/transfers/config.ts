import { UPLOAD_LIMITS, uploadKindOf, type UploadKind } from '@rolling/core/media/limits';

/**
 * Transfer manager limits and tuning (D-011). Every number the queue uses
 * lives here so the UI, the worker and the tests read the same values.
 */
export interface ConcurrencyConfig {
  /** Files uploading at once. */
  maxUploads: number;
  /** Parts in flight per file. */
  partsPerUpload: number;
  /** Starting global cap on parts in flight across all uploads (adaptive, AIMD). */
  globalParts: number;
  /** AIMD floor and ceiling for the global cap. */
  minGlobalParts: number;
  maxGlobalParts: number;
  /** Downloads running at once. */
  maxDownloads: number;
  /** Chunks in flight per download. */
  chunksPerDownload: number;
  /** Global cap on download chunks in flight. */
  downloadChunks: number;
}

export interface RetryConfig {
  /** Attempts per part or chunk before the item fails (network errors while offline do not count). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface TransfersConfig {
  concurrency: ConcurrencyConfig;
  retry: RetryConfig;
  /** Download chunk size (Range requests). Upload part size comes from the server (8 MiB). */
  chunkSize: number;
  /** Files up to this size are copied into IndexedDB so they resume after reload without a re-pick. */
  persistBlobMaxBytes: number;
  /** Budget for downloaded and cached files in OPFS (or IndexedDB), LRU-evicted. */
  cacheBudgetBytes: number;
  /** Refresh presigned part URLs this long before they expire. */
  urlRefreshMarginMs: number;
  /** A part or chunk request with no progress for this long is aborted and retried (counts as congestion). */
  stallTimeoutMs: number;
  /** Speed EMA smoothing factor per second (0..1, higher reacts faster). */
  speedAlpha: number;
  /** Where API calls go; '' means same origin. */
  apiBase: string;
  /** 'auto' uses the dev mock only on localhost when no API answers `/api/health`. */
  api: 'auto' | 'real' | 'mock';
}

export const MiB = 1024 * 1024;

export const DEFAULT_CONFIG: TransfersConfig = {
  concurrency: {
    maxUploads: 4,
    partsPerUpload: 4,
    globalParts: 8,
    minGlobalParts: 2,
    maxGlobalParts: 16,
    maxDownloads: 3,
    chunksPerDownload: 3,
    downloadChunks: 6,
  },
  retry: { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 30_000 },
  chunkSize: 8 * MiB,
  persistBlobMaxBytes: 500 * 1000 * 1000,
  cacheBudgetBytes: 1024 * MiB,
  urlRefreshMarginMs: 2 * 60_000,
  stallTimeoutMs: 45_000,
  speedAlpha: 0.3,
  apiBase: '',
  api: 'auto',
};

/** Deep-merges a partial config over the defaults. */
export function resolveConfig(partial?: DeepPartial<TransfersConfig>): TransfersConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    concurrency: { ...DEFAULT_CONFIG.concurrency, ...partial?.concurrency },
    retry: { ...DEFAULT_CONFIG.retry, ...partial?.retry },
  } as TransfersConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** Upload limits are shared with the server (`@rolling/core/media/limits`). */
export { UPLOAD_LIMITS };
export type { UploadKind };

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
};

/** The file's content type, falling back to its extension when the browser leaves `type` empty. */
export function contentTypeOf(file: { name: string; type: string }): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? 'application/octet-stream';
}

export type ValidationResult =
  | { ok: true; kind: UploadKind; contentType: string }
  | { ok: false; reason: 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'EMPTY'; kind?: UploadKind; maxBytes?: number; contentType: string };

/** Same rules as the server: known type per kind and a per-kind size cap. */
export function validateUpload(file: { name: string; type: string; size: number }): ValidationResult {
  const contentType = contentTypeOf(file);
  const kind = uploadKindOf(contentType);
  if (!kind) return { ok: false, reason: 'UNSUPPORTED_TYPE', contentType };
  if (file.size <= 0) return { ok: false, reason: 'EMPTY', kind, contentType };
  const maxBytes = UPLOAD_LIMITS[kind].maxBytes;
  if (file.size > maxBytes) return { ok: false, reason: 'TOO_LARGE', kind, maxBytes, contentType };
  return { ok: true, kind, contentType };
}
