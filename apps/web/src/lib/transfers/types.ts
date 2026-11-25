/**
 * Shapes shared by the transfer engine (worker) and the tab clients (D-011).
 * Everything crossing the port must survive structured clone.
 */
import type { DeepPartial, TransfersConfig } from './config';

export type TransferKind = 'upload' | 'download' | 'fetch';

export type TransferStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'paused'
  | 'retrying'
  /** Upload restored after reload without its bytes: the user must pick the file again. */
  | 'needsFile'
  | 'completing'
  | 'done'
  | 'failed'
  | 'canceled';

export type Purpose = 'reference' | 'library' | 'tool' | 'canvas' | 'other';

/** Priority bump for an item the user is waiting on (e.g. referenced in the prompt). */
export type Priority = 'normal' | 'high';

export interface TransferError {
  code: string;
  message: string;
  status?: number;
}

export interface TransferItem {
  id: string;
  kind: TransferKind;
  name: string;
  size: number;
  contentType: string;
  status: TransferStatus;
  priority: Priority;
  bytesDone: number;
  /** Bytes per second, exponential moving average. */
  speed: number;
  /** Seconds left at the current speed, null when unknown. */
  eta: number | null;
  createdAt: number;
  updatedAt: number;
  /** Paused by the user (as opposed to the global pause). */
  userPaused: boolean;
  error?: TransferError;
  nextRetryAt?: number;
  /** Upload fields. */
  assetId?: string;
  projectId?: string;
  purpose?: Purpose;
  fingerprint?: string;
  /** The bytes are stored in IndexedDB (≤ persistBlobMaxBytes) and survive reload. */
  persisted?: boolean;
  /** Download fields. */
  url?: string;
  filename?: string;
  /** Hidden from the dock (fetchBlob cache fills). */
  hidden?: boolean;
}

export interface QueueSnapshot {
  items: TransferItem[];
  paused: boolean;
  online: boolean;
  /** Current adaptive global cap on upload parts in flight. */
  uploadCap: number;
  /** Upload parts in flight right now. */
  partsInFlight: number;
  /** Where the engine runs. */
  mode: TransportMode;
  /** 'mock' when the dev mock backend serves uploads. */
  api: 'real' | 'mock' | 'pending';
}

export type TransportMode = 'shared' | 'dedicated' | 'main';

export interface UploadRequest {
  id: string;
  file: Blob;
  name: string;
  lastModified: number;
  contentType: string;
  projectId?: string;
  purpose: Purpose;
  priority: Priority;
}

export interface DownloadRequest {
  id: string;
  url: string;
  filename: string;
  size?: number;
  /** Dedupe key; defaults to the URL without signature parameters. */
  key?: string;
  hidden?: boolean;
  /** 'fetch' keeps the result in the LRU cache and hands back a Blob. */
  kind: 'download' | 'fetch';
  /** The requesting tab can mint a fresh URL when this one expires. */
  canRefresh: boolean;
}

/** Tab → engine. */
export type ClientMessage =
  | { type: 'hello'; clientId: string; config?: DeepPartial<TransfersConfig> }
  | { type: 'ping' }
  | { type: 'bye' }
  | { type: 'upload'; requests: UploadRequest[] }
  | { type: 'attachFile'; id: string; file: Blob; name: string; lastModified: number }
  | { type: 'offerFiles'; files: Array<{ file: Blob; name: string; lastModified: number }>; reqId: string }
  | { type: 'download'; request: DownloadRequest; reqId: string }
  | { type: 'refreshedUrl'; reqId: string; url: string | null }
  | { type: 'pause'; id?: string }
  | { type: 'resume'; id?: string }
  | { type: 'cancel'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'prioritize'; id: string; priority: Priority }
  | { type: 'clear' }
  | { type: 'getBlob'; id: string; reqId: string }
  | { type: 'setOnline'; online: boolean };

export type TransferEvent =
  | { type: 'asset.uploaded'; id: string; assetId: string; asset?: unknown; name: string; purpose?: Purpose }
  | { type: 'transfer.failed'; id: string; kind: TransferKind; name: string; error: TransferError }
  | { type: 'transfer.done'; id: string; kind: TransferKind; name: string }
  | { type: 'transfer.canceled'; id: string; kind: TransferKind; name: string };

/** Engine → tab. */
export type EngineMessage =
  | { type: 'state'; snapshot: QueueSnapshot }
  | { type: 'event'; event: TransferEvent }
  | { type: 'blob'; reqId: string; id: string; blob: Blob | null; filename?: string; error?: TransferError }
  | { type: 'downloadStarted'; reqId: string; id: string; deduped: boolean }
  | { type: 'refreshUrl'; reqId: string; id: string; url: string }
  | { type: 'offered'; reqId: string; matched: Array<{ index: number; id: string }> }
  | { type: 'pong' };

/** The engine's view of one connected tab. */
export interface PortLike {
  postMessage(message: EngineMessage, transfer?: Transferable[]): void;
}
