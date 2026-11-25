/**
 * Tab-side API of the transfer manager (D-011). One client per tab talks to
 * the shared engine; every tab sees the same queue in shared mode.
 */
import type { DeepPartial, TransfersConfig, ValidationResult } from './config';
import { validateUpload } from './config';
import { connectTransport, type Transport } from './transport';
import { durationField, isTimed, mediaDurationMs } from './duration';
import type {
  ClientMessage,
  EngineMessage,
  Priority,
  Purpose,
  QueueSnapshot,
  TransferError,
  TransferEvent,
  TransferItem,
  TransportMode,
} from './types';

export interface TransfersGlobalOverrides {
  config?: DeepPartial<TransfersConfig>;
  /** Force the transport (tests). */
  mode?: TransportMode;
  /** Expose the client as `window.__rollingTransfers` (tests, debugging). */
  expose?: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __ROLLING_TRANSFERS__: TransfersGlobalOverrides | undefined;
}

export interface UploadOptions {
  projectId?: string;
  purpose: Purpose;
  /** The user is waiting on these (e.g. referenced in the prompt). */
  priority?: Priority;
  /** The caller shows its own completion feedback; the dock skips its toast. */
  quiet?: boolean;
}

export interface UploadResult {
  id: string;
  assetId: string;
  asset?: unknown;
}

export interface UploadHandle {
  id: string;
  file: File;
  /** Resolves when the server has the asset; rejects when canceled. Failures can be retried, so they do not reject. */
  done: Promise<UploadResult>;
}

export interface Rejected {
  file: File;
  validation: Extract<ValidationResult, { ok: false }>;
}

export interface DownloadOptions {
  filename: string;
  size?: number;
  key?: string;
  /** Mint a fresh signed URL when the current one expires mid-download. */
  refreshUrl?: (oldUrl: string) => Promise<string | null>;
  /** How to hand the file to the user. 'auto' uses the save picker when available. */
  save?: 'auto' | 'picker' | 'anchor' | 'none';
}

export interface FetchBlobOptions {
  key?: string;
  size?: number;
  refreshUrl?: (oldUrl: string) => Promise<string | null>;
}

type EventMap = { [K in TransferEvent['type']]: Extract<TransferEvent, { type: K }> };
type Listener<K extends keyof EventMap> = (e: EventMap[K]) => void;

const EMPTY: QueueSnapshot = { items: [], paused: false, online: true, uploadCap: 0, partsInFlight: 0, mode: 'shared', api: 'pending' };

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

interface SaveTarget {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

type SavePicker = (opts: { suggestedName?: string }) => Promise<SaveTarget>;

export class TransfersClient {
  private transport: Transport | null = null;
  private snapshot: QueueSnapshot = EMPTY;
  private readonly stateListeners = new Set<() => void>();
  private readonly eventListeners = new Map<string, Set<(e: TransferEvent) => void>>();
  private readonly uploadWaiters = new Map<string, { resolve: (r: UploadResult) => void; reject: (e: Error) => void }>();
  private readonly blobWaiters = new Map<string, { resolve: (b: { blob: Blob; filename?: string }) => void; reject: (e: TransferError) => void }>();
  private readonly startWaiters = new Map<string, (id: string) => void>();
  private readonly offerWaiters = new Map<string, (m: Array<{ index: number; id: string }>) => void>();
  private readonly itemRefreshers = new Map<string, (oldUrl: string) => Promise<string | null>>();
  private readonly clientId = uid('tab');
  private readonly pendingDone = new Map<string, Promise<UploadResult>>();
  private readonly rejectListeners = new Set<(r: Rejected[]) => void>();
  /** Items this tab started (only this tab toasts about them). */
  private readonly mine = new Map<string, { quiet: boolean }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly overrides: () => TransfersGlobalOverrides = () => globalThis.__ROLLING_TRANSFERS__ ?? {}) {}

  /** Connects on first use. */
  connect(): Transport {
    if (this.transport) return this.transport;
    const o = this.overrides();
    const t = connectTransport({ force: o.mode });
    this.transport = t;
    this.snapshot = { ...this.snapshot, mode: t.mode };
    t.onMessage((m) => this.onMessage(m));
    t.post({ type: 'hello', clientId: this.clientId, config: o.config });
    if (typeof window !== 'undefined') {
      this.pingTimer = setInterval(() => this.post({ type: 'ping' }), 10_000);
      window.addEventListener('pagehide', () => this.post({ type: 'bye' }));
      window.addEventListener('online', () => this.post({ type: 'setOnline', online: true }));
      window.addEventListener('offline', () => this.post({ type: 'setOnline', online: false }));
    }
    return t;
  }

  private post(m: ClientMessage) {
    this.connect().post(m);
  }

  private onMessage(m: EngineMessage) {
    switch (m.type) {
      case 'state':
        this.snapshot = m.snapshot;
        for (const l of this.stateListeners) l();
        return;
      case 'event': {
        const e = m.event;
        if (e.type === 'asset.uploaded') {
          this.uploadWaiters.get(e.id)?.resolve({ id: e.id, assetId: e.assetId, asset: e.asset });
          this.uploadWaiters.delete(e.id);
        } else if (e.type === 'transfer.canceled') {
          this.uploadWaiters.get(e.id)?.reject(new Error('canceled'));
          this.uploadWaiters.delete(e.id);
        }
        for (const l of this.eventListeners.get(e.type) ?? []) l(e);
        for (const l of this.eventListeners.get('*') ?? []) l(e);
        return;
      }
      case 'blob': {
        const w = this.blobWaiters.get(m.reqId);
        this.blobWaiters.delete(m.reqId);
        if (!w) return;
        if (m.blob) w.resolve({ blob: m.blob, filename: m.filename });
        else w.reject(m.error ?? { code: 'FAILED', message: 'Download failed' });
        return;
      }
      case 'downloadStarted':
        this.startWaiters.get(m.reqId)?.(m.id);
        this.startWaiters.delete(m.reqId);
        return;
      case 'refreshUrl': {
        const fn = this.itemRefreshers.get(m.id) ?? null;
        void (async () => {
          let url: string | null = null;
          try {
            url = fn ? await fn(m.url) : null;
          } catch {
            url = null;
          }
          this.post({ type: 'refreshedUrl', reqId: m.reqId, url });
        })();
        return;
      }
      case 'offered':
        this.offerWaiters.get(m.reqId)?.(m.matched);
        this.offerWaiters.delete(m.reqId);
        return;
      case 'pong':
        return;
    }
  }

  // ---------------------------------------------------------------- state

  subscribe = (cb: () => void): (() => void) => {
    this.connect();
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  };

  getSnapshot = (): QueueSnapshot => this.snapshot;

  on<K extends keyof EventMap>(type: K | '*', cb: Listener<K>): () => void {
    this.connect();
    const set = this.eventListeners.get(type) ?? new Set();
    set.add(cb as (e: TransferEvent) => void);
    this.eventListeners.set(type, set);
    return () => set.delete(cb as (e: TransferEvent) => void);
  }

  /** Files refused client-side (type or size), in this tab. The dock explains them. */
  onRejected(cb: (r: Rejected[]) => void): () => void {
    this.rejectListeners.add(cb);
    return () => this.rejectListeners.delete(cb);
  }

  /**
   * The asset id for an id handed out before the upload finished (upload item
   * ids are used as provisional reference ids). Other ids pass through.
   */
  async resolveAssetId(id: string): Promise<string> {
    const waiter = this.uploadWaiters.get(id);
    const item = this.snapshot.items.find((i) => i.id === id);
    if (item?.status === 'done' && item.assetId) return item.assetId;
    if (!waiter && !item) return id;
    const done = this.pendingDone.get(id);
    return done ? (await done).assetId : id;
  }

  // ---------------------------------------------------------------- uploads

  /** Validates client-side (type and size limits), then queues the accepted files. */
  uploadFiles(files: File[], opts: UploadOptions): { items: UploadHandle[]; rejected: Rejected[] } {
    const items: UploadHandle[] = [];
    const rejected: Rejected[] = [];
    const requests = [];
    for (const file of files) {
      const v = validateUpload(file);
      if (!v.ok) {
        rejected.push({ file, validation: v });
        continue;
      }
      const id = uid('upl');
      const done = new Promise<UploadResult>((resolve, reject) => this.uploadWaiters.set(id, { resolve, reject }));
      done.catch(() => undefined);
      this.pendingDone.set(id, done);
      items.push({ id, file, done });
      this.mine.set(id, { quiet: !!opts.quiet });
      requests.push({
        id,
        file,
        name: file.name,
        lastModified: file.lastModified,
        contentType: v.contentType,
        projectId: opts.projectId,
        purpose: opts.purpose,
        priority: opts.priority ?? 'normal',
      });
    }
    if (requests.length) {
      // Audio/video: read the length in this tab first (metadata only, bounded wait) so a
      // quote right after the upload has a duration before the server probed the file.
      if (requests.some((r) => isTimed(r.contentType))) {
        void Promise.all(requests.map(async (r) => (isTimed(r.contentType) ? { ...r, ...durationField(await mediaDurationMs(r.file)) } : r))).then((rs) =>
          this.post({ type: 'upload', requests: rs }),
        );
      } else this.post({ type: 'upload', requests });
    }
    if (rejected.length) for (const l of this.rejectListeners) l(rejected);
    return { items, rejected };
  }

  /** Re-picked files: resumes every stalled upload whose fingerprint matches. Returns the matched item ids. */
  offerFiles(files: File[]): Promise<Array<{ file: File; id: string }>> {
    const reqId = uid('offer');
    return new Promise((resolve) => {
      this.offerWaiters.set(reqId, (m) => resolve(m.map(({ index, id }) => ({ file: files[index]!, id }))));
      this.post({ type: 'offerFiles', reqId, files: files.map((f) => ({ file: f, name: f.name, lastModified: f.lastModified })) });
    });
  }

  // ---------------------------------------------------------------- downloads

  private request(url: string, kind: 'download' | 'fetch', o: { filename: string; size?: number; key?: string; refreshUrl?: DownloadOptions['refreshUrl'] }) {
    const reqId = uid('req');
    const id = uid(kind === 'fetch' ? 'fch' : 'dl');
    const started = new Promise<string>((resolve) => this.startWaiters.set(reqId, resolve));
    const result = new Promise<{ blob: Blob; filename?: string }>((resolve, reject) => this.blobWaiters.set(reqId, { resolve, reject }));
    if (o.refreshUrl) {
      const fn = o.refreshUrl;
      void started.then((itemId) => this.itemRefreshers.set(itemId, fn));
    }
    this.post({
      type: 'download',
      reqId,
      request: { id, url: absolute(url), filename: o.filename, size: o.size, key: o.key, kind, canRefresh: !!o.refreshUrl },
    });
    return { started, result };
  }

  /**
   * Downloads through the shared queue (Range chunks, resumable, deduped
   * across tabs), then saves it. With the save picker, the picker opens first
   * (it needs the click's user activation) and the bytes stream into the file.
   */
  async download(url: string, opts: DownloadOptions): Promise<{ id: string; saved: boolean }> {
    const mode = opts.save ?? 'auto';
    const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let target: SaveTarget | null = null;
    if ((mode === 'auto' || mode === 'picker') && typeof picker === 'function') {
      try {
        target = await picker({ suggestedName: opts.filename });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return { id: '', saved: false };
        target = null;
      }
    }
    const { started, result } = this.request(url, 'download', opts);
    const id = await started;
    this.mine.set(id, { quiet: false });
    const { blob, filename } = await result.catch((e: TransferError) => {
      throw Object.assign(new Error(e.message), { code: e.code });
    });
    if (mode === 'none') return { id, saved: false };
    await saveBlob(blob, filename ?? opts.filename, target);
    return { id, saved: true };
  }

  /** For in-app use (previews, editor): the same queue, kept in the LRU cache. */
  async fetchBlob(url: string, opts: FetchBlobOptions = {}): Promise<Blob> {
    const filename = decodeURIComponent(new URL(absolute(url)).pathname.split('/').pop() || 'file');
    const { result } = this.request(url, 'fetch', { filename, ...opts });
    const { blob } = await result.catch((e: TransferError) => {
      throw Object.assign(new Error(e.message), { code: e.code });
    });
    return blob;
  }

  /** Saves a finished download from the dock (any tab). */
  async save(id: string): Promise<void> {
    const item = this.snapshot.items.find((i) => i.id === id);
    const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    let target: SaveTarget | null = null;
    if (typeof picker === 'function') {
      try {
        target = await picker({ suggestedName: item?.filename ?? item?.name });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
      }
    }
    const reqId = uid('get');
    const result = new Promise<{ blob: Blob; filename?: string }>((resolve, reject) => this.blobWaiters.set(reqId, { resolve, reject }));
    this.post({ type: 'getBlob', id, reqId });
    const { blob, filename } = await result;
    await saveBlob(blob, filename ?? item?.name ?? 'download', target);
  }

  // ---------------------------------------------------------------- controls

  pause(id?: string) {
    this.post({ type: 'pause', id });
  }
  resume(id?: string) {
    this.post({ type: 'resume', id });
  }
  cancel(id: string) {
    this.post({ type: 'cancel', id });
  }
  retry(id: string) {
    this.post({ type: 'retry', id });
  }
  prioritize(id: string, priority: Priority = 'high') {
    this.post({ type: 'prioritize', id, priority });
  }
  clearFinished() {
    this.post({ type: 'clear' });
  }

  /** Whether this tab started the item, and whether it asked for no toast. */
  ownership(id: string): { mine: boolean; quiet: boolean } {
    const m = this.mine.get(id);
    return { mine: !!m, quiet: m?.quiet ?? false };
  }

  get mode(): TransportMode {
    return this.connect().mode;
  }

  /** Visible items only. */
  get items(): TransferItem[] {
    return this.snapshot.items.filter((i) => !i.hidden);
  }

  dispose() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.transport?.close();
    this.transport = null;
  }
}

function absolute(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).toString();
  } catch {
    return url;
  }
}

async function saveBlob(blob: Blob, filename: string, target: SaveTarget | null) {
  if (target) {
    const w = await target.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
