/**
 * The transfer engine (D-011): one queue of uploads and downloads with
 * priorities, fair scheduling, adaptive concurrency, retry with backoff and
 * persistence. It runs in the SharedWorker (one per origin), a dedicated
 * worker per tab, or the main thread; it only sees ports.
 *
 * Upload contract (direct to R2, presigned):
 *   POST /api/assets/uploads {filename, contentType, size, fingerprint, projectId?, durationMs?}
 *     → {assetId, uploadId, partSize, partCount, expiresAt, parts:[{n,size,etag}]}
 *   POST /api/assets/uploads/:assetId/part-urls {partNumbers} → {urls:[{n,url,expiresAt}]}
 *   PUT <presigned url> (credentials omitted) → ETag header
 *   GET /api/assets/uploads/:assetId → {parts:[{n,size,etag}], ...} (ListParts)
 *   POST /api/assets/uploads/:assetId/complete → {asset}
 *   DELETE /api/assets/uploads/:assetId (abort)
 * Older servers without `part-urls` get parts through the Worker
 * (`PUT /api/assets/uploads/:assetId/parts/:n`).
 */
import { DEFAULT_CONFIG, resolveConfig, type DeepPartial, type TransfersConfig } from './config';
import { fingerprint as defaultFingerprint } from './fingerprint';
import { AbortError, type Http } from './http';
import { etaSeconds, SpeedMeter } from './progress';
import { Aimd, isCongestionStatus, isRetryableStatus, pickParts, activeFiles, retryDelay, type SchedFile } from './scheduler';
import type { ChunkStore, DownloadSession, PersistedRecord, Persistence, UploadSession } from './store';
import type {
  ClientMessage,
  DownloadRequest,
  EngineMessage,
  PortLike,
  Priority,
  QueueSnapshot,
  TransferError,
  TransferEvent,
  TransferItem,
  TransportMode,
  UploadRequest,
} from './types';

export interface EngineDeps {
  http: Http;
  persistence: Persistence;
  chunks: ChunkStore;
  owner: string;
  mode: TransportMode;
  /** Resolves which backend serves uploads; called once on start. */
  resolveApi?: (config: TransfersConfig) => Promise<{ api: 'real' | 'mock'; http: Http }>;
  /** Serializes adoption of orphaned records across engines (Web Locks). */
  withAdoptLock?: (fn: () => Promise<void>) => Promise<void>;
  /** Calls back once the engine `owner` is gone (its tab closed or reloaded). */
  whenOwnerGone?: (owner: string, cb: () => void) => void;
  /** Ids of engines that are still alive (fallback mode adopts orphans only). */
  liveOwners?: () => Promise<Set<string> | null>;
  now?: () => number;
  random?: () => number;
  fingerprint?: (file: Blob, name: string, lastModified: number) => Promise<string>;
  online?: boolean;
  /** Broadcast throttle, ms. */
  broadcastMs?: number;
}

interface PartSlot {
  abort: AbortController;
  loaded: number;
  stall?: ReturnType<typeof setTimeout>;
}

interface UploadRt {
  kind: 'upload';
  item: TransferItem;
  session?: UploadSession;
  file?: Blob;
  lastModified?: number;
  slot: boolean;
  preparing: boolean;
  needsSync: boolean;
  completing: boolean;
  inFlight: Map<number, PartSlot>;
  attempts: Map<number, number>;
  waiting: Map<number, ReturnType<typeof setTimeout>>;
  urls: Map<number, { url: string; expiresAt: number }>;
  urlFetch?: Promise<void>;
  /** Server without presigned part URLs: parts go through the Worker. */
  proxied: boolean;
  meter: SpeedMeter;
  aliases: string[];
  waiters: Array<{ port: PortLike; reqId: string }>;
}

interface DownloadRt {
  kind: 'download' | 'fetch';
  item: TransferItem;
  session: DownloadSession;
  slot: boolean;
  probing: boolean;
  inFlight: Map<number, PartSlot>;
  attempts: Map<number, number>;
  waiting: Map<number, ReturnType<typeof setTimeout>>;
  meter: SpeedMeter;
  requesters: Array<{ port: PortLike; reqId: string; canRefresh: boolean }>;
  refreshing?: Promise<boolean>;
  assembling: boolean;
}

type Rt = UploadRt | DownloadRt;

const HISTORY_LIMIT = 50;
const PORT_TIMEOUT_MS = 35_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

const SIGNATURE_PARAMS = ['exp', 'sig', 'ws', 'token', 'expires', 'signature', 'x-amz-signature', 'x-amz-date', 'x-amz-credential', 'x-amz-expires', 'x-amz-security-token', 'x-amz-signedheaders', 'x-amz-algorithm'];

/** Dedupe key for a download: the URL without signature/expiry parameters. */
export function downloadKey(url: string): string {
  try {
    const u = new URL(url, 'http://local.invalid');
    for (const k of [...u.searchParams.keys()]) if (SIGNATURE_PARAMS.includes(k.toLowerCase())) u.searchParams.delete(k);
    return u.origin === 'http://local.invalid' ? `${u.pathname}${u.search}` : u.toString();
  } catch {
    return url;
  }
}

/** `bytes 0-8388607/52428800` → total; null if absent. */
export function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

export class TransferEngine {
  config: TransfersConfig = DEFAULT_CONFIG;
  private readonly items = new Map<string, Rt>();
  private readonly ports = new Map<PortLike, { clientId: string; lastSeen: number }>();
  private paused = false;
  private online: boolean;
  private aimd: Aimd;
  private api: 'real' | 'mock' | 'pending' = 'pending';
  private apiHttp: Http;
  private started: Promise<void> | null = null;
  private loaded = false;
  private readonly watchedOwners = new Set<string>();
  private apiReady: Promise<void> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private refreshSeq = 0;
  private readonly refreshWaiters = new Map<string, (url: string | null) => void>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly fp: NonNullable<EngineDeps['fingerprint']>;
  private readonly onlineListeners: Array<() => void> = [];

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.fp = deps.fingerprint ?? defaultFingerprint;
    this.online = deps.online ?? true;
    this.apiHttp = deps.http;
    this.aimd = new Aimd(this.config.concurrency.globalParts, this.config.concurrency.minGlobalParts, this.config.concurrency.maxGlobalParts, this.now);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Applies config (first caller wins for apiBase/api) and loads persisted state once. */
  start(config?: DeepPartial<TransfersConfig>): Promise<void> {
    if (this.started) return this.started;
    this.config = resolveConfig(config);
    const c = this.config.concurrency;
    this.aimd = new Aimd(c.globalParts, c.minGlobalParts, c.maxGlobalParts, this.now);
    this.started = this.load();
    this.sweepTimer = setInterval(() => this.sweepPorts(), 10_000);
    return this.started;
  }

  private async load() {
    if (!this.deps.resolveApi) this.api = 'real';
    const adopt = this.deps.withAdoptLock ?? ((fn: () => Promise<void>) => fn());
    await adopt(() => this.adopt());
    this.loaded = true;
    this.pump();
    this.broadcast(true);
  }

  /** Resolves the upload backend once, lazily (first upload), so idle tabs never probe the API. */
  private ensureApi(): Promise<void> {
    if (!this.apiReady) {
      this.apiReady = (async () => {
        const resolved = await this.deps.resolveApi!(this.config).catch(() => ({ api: 'real' as const, http: this.deps.http }));
        this.api = resolved.api;
        this.apiHttp = resolved.http;
        this.pump();
        this.broadcast(true);
      })();
    }
    return this.apiReady;
  }

  private async adopt() {
    const records = await this.deps.persistence.loadAll();
    const live = this.deps.liveOwners ? await this.deps.liveOwners() : null;
    for (const rec of records) {
      if (this.items.has(rec.id)) continue;
      // Fallback mode: another tab's engine still owns this record; adopt it once that engine is gone.
      if (live && rec.owner !== this.deps.owner && live.has(rec.owner)) {
        if (!this.watchedOwners.has(rec.owner) && this.deps.whenOwnerGone) {
          this.watchedOwners.add(rec.owner);
          this.deps.whenOwnerGone(rec.owner, () => {
            const adopt = this.deps.withAdoptLock ?? ((fn: () => Promise<void>) => fn());
            void adopt(() => this.adopt()).then(() => {
              this.pump();
              this.broadcast(true);
            });
          });
        }
        continue;
      }
      const item = { ...rec.item, speed: 0, eta: null, nextRetryAt: undefined };
      if (rec.item.kind === 'upload') {
        const rt = this.newUploadRt(item);
        rt.session = rec.upload;
        if (!['done', 'failed', 'canceled'].includes(item.status)) {
          const blob = item.persisted ? await this.deps.persistence.getBlob(rec.id) : undefined;
          if (blob) {
            rt.file = blob;
            item.status = item.userPaused ? 'paused' : 'queued';
          } else {
            item.status = 'needsFile';
          }
          rt.needsSync = true;
        }
        this.items.set(rec.id, rt);
      } else if (rec.download) {
        const rt = this.newDownloadRt(item, rec.download);
        if (!['done', 'failed', 'canceled'].includes(item.status)) item.status = item.userPaused ? 'paused' : 'queued';
        this.items.set(rec.id, rt);
      }
      if (rec.owner !== this.deps.owner && this.items.has(rec.id)) await this.persist(this.items.get(rec.id)!);
    }
  }

  connect(port: PortLike): (msg: ClientMessage) => void {
    this.ports.set(port, { clientId: '', lastSeen: this.now() });
    return (msg) => {
      const entry = this.ports.get(port);
      if (entry) entry.lastSeen = this.now();
      void this.handle(port, msg);
    };
  }

  disconnect(port: PortLike) {
    this.ports.delete(port);
    for (const rt of this.items.values()) {
      if (rt.kind === 'upload') rt.waiters = rt.waiters.filter((w) => w.port !== port);
      else rt.requesters = rt.requesters.filter((r) => r.port !== port);
    }
  }

  get portCount() {
    return this.ports.size;
  }

  private sweepPorts() {
    const t = this.now();
    for (const [port, info] of this.ports) if (t - info.lastSeen > PORT_TIMEOUT_MS) this.disconnect(port);
  }

  dispose() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    for (const rt of this.items.values()) this.abortAll(rt);
  }

  setOnline(online: boolean) {
    if (online === this.online) return;
    this.online = online;
    if (online) {
      for (const rt of this.items.values()) {
        // Come back fast: drop backoff timers set while offline.
        for (const [n, t] of rt.waiting) {
          clearTimeout(t);
          rt.waiting.delete(n);
        }
        if (rt.item.status === 'retrying') rt.item.status = 'running';
        if (rt.kind === 'upload' && rt.session) rt.needsSync = true;
        rt.item.nextRetryAt = undefined;
      }
      for (const l of this.onlineListeners.splice(0)) l();
      this.pump();
    }
    this.broadcast(true);
  }

  // ---------------------------------------------------------------- messages

  private async handle(port: PortLike, msg: ClientMessage) {
    if (msg.type === 'hello') {
      const entry = this.ports.get(port);
      if (entry) entry.clientId = msg.clientId;
      await this.start(msg.config);
      this.send(port, { type: 'state', snapshot: this.snapshot() });
      return;
    }
    if (msg.type === 'ping') return this.send(port, { type: 'pong' });
    if (msg.type === 'bye') return this.disconnect(port);
    await this.start();
    switch (msg.type) {
      case 'upload':
        return this.addUploads(port, msg.requests);
      case 'offerFiles':
        return this.offerFiles(port, msg.reqId, msg.files);
      case 'attachFile':
        return void this.offerFiles(port, '', [{ file: msg.file, name: msg.name, lastModified: msg.lastModified }]);
      case 'download':
        return this.addDownload(port, msg.reqId, msg.request);
      case 'refreshedUrl': {
        const w = this.refreshWaiters.get(msg.reqId);
        this.refreshWaiters.delete(msg.reqId);
        return w?.(msg.url);
      }
      case 'pause':
        return msg.id ? this.pauseItem(msg.id) : this.setPaused(true);
      case 'resume':
        return msg.id ? this.resumeItem(msg.id) : this.setPaused(false);
      case 'cancel':
        return this.cancel(msg.id);
      case 'retry':
        return this.retry(msg.id);
      case 'prioritize': {
        const rt = this.items.get(msg.id);
        if (rt) {
          rt.item.priority = msg.priority;
          this.pump();
          this.broadcast(true);
        }
        return;
      }
      case 'clear':
        return this.clearFinished();
      case 'getBlob':
        return this.sendBlob(port, msg.reqId, msg.id);
      case 'setOnline':
        return this.setOnline(msg.online);
    }
  }

  private send(port: PortLike, msg: EngineMessage) {
    try {
      port.postMessage(msg);
    } catch {
      this.disconnect(port);
    }
  }

  private emit(event: TransferEvent) {
    for (const port of [...this.ports.keys()]) this.send(port, { type: 'event', event });
  }

  snapshot(): QueueSnapshot {
    const items = [...this.items.values()].map((rt) => ({ ...rt.item })).sort((a, b) => a.createdAt - b.createdAt);
    let partsInFlight = 0;
    for (const rt of this.items.values()) if (rt.kind === 'upload') partsInFlight += rt.inFlight.size;
    return { items, paused: this.paused, online: this.online, uploadCap: this.aimd.cap, partsInFlight, mode: this.deps.mode, api: this.api };
  }

  /** Throttled state fan-out; `now` flushes immediately (status changes). */
  private broadcast(now = false) {
    if (now) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
      const snapshot = this.snapshot();
      for (const port of [...this.ports.keys()]) this.send(port, { type: 'state', snapshot });
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => this.broadcast(true), this.deps.broadcastMs ?? 200);
  }

  // ---------------------------------------------------------------- items

  private newItem(partial: Partial<TransferItem> & Pick<TransferItem, 'id' | 'kind' | 'name' | 'size'>): TransferItem {
    const t = this.now();
    return {
      contentType: '',
      status: 'queued',
      priority: 'normal',
      bytesDone: 0,
      speed: 0,
      eta: null,
      createdAt: t,
      updatedAt: t,
      userPaused: false,
      ...partial,
    };
  }

  private newUploadRt(item: TransferItem): UploadRt {
    return {
      kind: 'upload',
      item,
      slot: false,
      preparing: false,
      needsSync: false,
      completing: false,
      inFlight: new Map(),
      attempts: new Map(),
      waiting: new Map(),
      urls: new Map(),
      proxied: false,
      meter: new SpeedMeter(this.config.speedAlpha, this.now),
      aliases: [],
      waiters: [],
    };
  }

  private newDownloadRt(item: TransferItem, session: DownloadSession): DownloadRt {
    return {
      kind: item.kind === 'fetch' ? 'fetch' : 'download',
      item,
      session,
      slot: false,
      probing: false,
      inFlight: new Map(),
      attempts: new Map(),
      waiting: new Map(),
      meter: new SpeedMeter(this.config.speedAlpha, this.now),
      requesters: [],
      assembling: false,
    };
  }

  private persist(rt: Rt): Promise<void> {
    const rec: PersistedRecord = { id: rt.item.id, owner: this.deps.owner, item: { ...rt.item } };
    if (rt.kind === 'upload') rec.upload = rt.session;
    else rec.download = rt.session;
    return this.deps.persistence.save(rec);
  }

  private setStatus(rt: Rt, status: TransferItem['status'], error?: TransferError) {
    rt.item.status = status;
    rt.item.updatedAt = this.now();
    if (error) rt.item.error = error;
    else if (status !== 'failed') delete rt.item.error;
    if (status !== 'retrying') rt.item.nextRetryAt = undefined;
    if (status !== 'running') {
      rt.item.speed = 0;
      rt.item.eta = null;
    }
    void this.persist(rt);
    this.broadcast(true);
  }

  private fail(rt: Rt, error: TransferError) {
    this.abortAll(rt);
    rt.slot = false;
    this.setStatus(rt, 'failed', error);
    this.emit({ type: 'transfer.failed', id: rt.item.id, kind: rt.item.kind, name: rt.item.name, error });
    if (rt.kind !== 'upload') for (const r of rt.requesters.splice(0)) this.send(r.port, { type: 'blob', reqId: r.reqId, id: rt.item.id, blob: null, error });
    this.pump();
  }

  private abortAll(rt: Rt) {
    for (const s of rt.inFlight.values()) {
      if (s.stall) clearTimeout(s.stall);
      s.abort.abort();
    }
    rt.inFlight.clear();
    for (const t of rt.waiting.values()) clearTimeout(t);
    rt.waiting.clear();
  }

  private runnable(rt: Rt): boolean {
    if (this.paused || !this.online || rt.item.userPaused) return false;
    if (!['queued', 'running', 'retrying', 'preparing'].includes(rt.item.status)) return false;
    if (rt.kind === 'upload' && !rt.file) return false;
    return true;
  }

  private setPaused(paused: boolean) {
    this.paused = paused;
    for (const rt of this.items.values()) {
      if (paused && ['queued', 'running', 'retrying', 'preparing'].includes(rt.item.status)) {
        this.abortAll(rt);
        this.resetProgressToDone(rt);
        rt.slot = false;
        rt.item.status = 'paused';
        void this.persist(rt);
      } else if (!paused && rt.item.status === 'paused' && !rt.item.userPaused) {
        rt.item.status = 'queued';
        void this.persist(rt);
      }
    }
    this.pump();
    this.broadcast(true);
  }

  private pauseItem(id: string) {
    const rt = this.items.get(id);
    if (!rt || ['done', 'canceled', 'failed', 'needsFile'].includes(rt.item.status)) return;
    rt.item.userPaused = true;
    this.abortAll(rt);
    this.resetProgressToDone(rt);
    rt.slot = false;
    this.setStatus(rt, 'paused');
    this.pump();
  }

  private resumeItem(id: string) {
    const rt = this.items.get(id);
    if (!rt) return;
    rt.item.userPaused = false;
    if (rt.item.status === 'paused') this.setStatus(rt, this.paused ? 'paused' : 'queued');
    this.pump();
  }

  private retry(id: string) {
    const rt = this.items.get(id);
    if (!rt || !['failed', 'paused', 'retrying'].includes(rt.item.status)) return;
    rt.attempts.clear();
    rt.item.userPaused = false;
    for (const t of rt.waiting.values()) clearTimeout(t);
    rt.waiting.clear();
    if (rt.kind === 'upload') {
      if (rt.session) rt.needsSync = true;
      this.setStatus(rt, rt.file ? 'queued' : 'needsFile');
    } else {
      this.setStatus(rt, 'queued');
    }
    this.pump();
  }

  private async cancel(id: string) {
    const rt = this.items.get(id);
    if (!rt) return;
    this.abortAll(rt);
    rt.slot = false;
    const wasDone = rt.item.status === 'done';
    rt.item.status = 'canceled';
    this.items.delete(id);
    if (rt.kind === 'upload') {
      if (rt.session && !wasDone) {
        const assetId = rt.session.assetId;
        void this.api_('DELETE', `/api/assets/uploads/${encodeURIComponent(assetId)}`).catch(() => undefined);
      }
    } else {
      void this.deps.chunks.delete(id);
      for (const r of rt.requesters.splice(0)) this.send(r.port, { type: 'blob', reqId: r.reqId, id, blob: null, error: { code: 'CANCELED', message: 'Canceled' } });
    }
    await this.deps.persistence.remove(id);
    if (!wasDone) this.emit({ type: 'transfer.canceled', id, kind: rt.item.kind, name: rt.item.name });
    this.pump();
    this.broadcast(true);
  }

  private clearFinished() {
    for (const [id, rt] of this.items) {
      if (!['done', 'failed'].includes(rt.item.status)) continue;
      if (rt.kind === 'upload') {
        this.items.delete(id);
        void this.deps.persistence.remove(id);
      } else if (rt.item.status === 'done') {
        // Keep the bytes as cache; just hide it from the dock.
        rt.item.hidden = true;
        void this.persist(rt);
      } else {
        this.items.delete(id);
        void this.deps.chunks.delete(id);
        void this.deps.persistence.remove(id);
      }
    }
    this.broadcast(true);
  }

  /** In-flight bytes are lost when a part is aborted; show only what is stored. */
  private resetProgressToDone(rt: Rt) {
    if (rt.kind === 'upload') {
      const s = rt.session;
      rt.item.bytesDone = s ? Object.keys(s.etags).reduce((sum, n) => sum + partBytes(rt.item.size, s.partSize, Number(n)), 0) : 0;
    } else {
      const s = rt.session;
      rt.item.bytesDone = s.done.reduce((sum, i) => sum + chunkBytes(s.total ?? rt.item.size, s.chunkSize, i), 0);
    }
    rt.meter.reset(rt.item.bytesDone);
  }

  // ---------------------------------------------------------------- uploads: intake

  private async addUploads(port: PortLike, requests: UploadRequest[]) {
    for (const r of requests) {
      const item = this.newItem({
        id: r.id,
        kind: 'upload',
        name: r.name,
        size: r.file.size,
        contentType: r.contentType,
        priority: r.priority,
        projectId: r.projectId,
        ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
        purpose: r.purpose,
        status: 'preparing',
      });
      const rt = this.newUploadRt(item);
      rt.file = r.file;
      rt.lastModified = r.lastModified;
      rt.waiters.push({ port, reqId: r.id });
      this.items.set(r.id, rt);
    }
    this.broadcast(true);
    await Promise.all(
      requests.map(async (r) => {
        const rt = this.items.get(r.id) as UploadRt | undefined;
        if (!rt) return;
        try {
          rt.item.fingerprint = await this.fp(r.file, r.name, r.lastModified);
        } catch {
          rt.item.fingerprint = `nofp:${r.id}`;
        }
        if (!this.items.has(r.id)) return; // canceled meanwhile
        // Same bytes as a stalled item (e.g. restored after reload): take over its session.
        const twin = [...this.items.values()].find(
          (o): o is UploadRt => o !== rt && o.kind === 'upload' && o.item.fingerprint === rt.item.fingerprint && !['done', 'canceled'].includes(o.item.status),
        );
        if (twin && (twin.item.status === 'needsFile' || twin.item.status === 'failed')) {
          rt.session = twin.session;
          rt.needsSync = !!twin.session;
          rt.item.createdAt = twin.item.createdAt;
          this.items.delete(twin.item.id);
          void this.deps.persistence.remove(twin.item.id);
          this.resetProgressToDone(rt);
        } else if (twin) {
          // Already uploading the same file: piggyback on it.
          twin.aliases.push(rt.item.id);
          twin.waiters.push(...rt.waiters);
          if (r.priority === 'high') twin.item.priority = 'high';
          this.items.delete(rt.item.id);
          this.broadcast(true);
          return;
        }
        rt.item.status = 'queued';
        if (r.file.size <= this.config.persistBlobMaxBytes) {
          rt.item.persisted = await this.deps.persistence.putBlob(r.id, r.file);
        }
        if (!this.items.has(r.id)) {
          void this.deps.persistence.remove(r.id);
          return;
        }
        await this.persist(rt);
        this.pump();
        this.broadcast(true);
      }),
    );
  }

  private async offerFiles(port: PortLike, reqId: string, files: Array<{ file: Blob; name: string; lastModified: number }>) {
    const matched: Array<{ index: number; id: string }> = [];
    await Promise.all(
      files.map(async (f, index) => {
        const fp = await this.fp(f.file, f.name, f.lastModified).catch(() => null);
        const rt = [...this.items.values()].find((o): o is UploadRt => o.kind === 'upload' && o.item.status === 'needsFile' && o.item.fingerprint === fp);
        if (!rt) return;
        rt.file = f.file;
        rt.lastModified = f.lastModified;
        rt.needsSync = !!rt.session;
        if (f.file.size <= this.config.persistBlobMaxBytes) rt.item.persisted = await this.deps.persistence.putBlob(rt.item.id, f.file);
        matched.push({ index, id: rt.item.id });
        this.setStatus(rt, rt.item.userPaused ? 'paused' : 'queued');
      }),
    );
    if (reqId) this.send(port, { type: 'offered', reqId, matched });
    this.pump();
  }

  // ---------------------------------------------------------------- scheduling

  /** Starts whatever the caps allow. Cheap; call after any change. */
  pump() {
    if (!this.loaded) return;
    this.pumpUploads();
    this.pumpDownloads();
  }

  private pumpUploads() {
    const c = this.config.concurrency;
    const uploads = [...this.items.values()].filter(
      (rt): rt is UploadRt => rt.kind === 'upload' && this.runnable(rt) && !rt.completing && !!rt.item.fingerprint,
    );
    if (!uploads.length) return;
    if (this.api === 'pending') {
      void this.ensureApi();
      return;
    }
    const sched: SchedFile[] = uploads.map((rt) => ({
      id: rt.item.id,
      size: rt.item.size,
      priority: rt.item.priority,
      createdAt: rt.item.createdAt,
      started: rt.slot,
      inFlight: rt.inFlight.size,
      pending: rt.session && !rt.needsSync && !rt.preparing ? this.pendingParts(rt).length : 0,
    }));
    const active = new Set(activeFiles(sched, c.maxUploads).map((f) => f.id));
    for (const rt of uploads) {
      if (!active.has(rt.item.id)) continue;
      rt.slot = true;
      if (!rt.session || rt.needsSync) {
        if (!rt.preparing) void this.prepare(rt);
        continue;
      }
      if (rt.item.status === 'queued') this.setStatus(rt, 'running');
      if (this.pendingParts(rt).length === 0 && rt.inFlight.size === 0 && rt.waiting.size === 0) void this.complete(rt);
    }
    let inFlight = 0;
    for (const rt of this.items.values()) if (rt.kind === 'upload') inFlight += rt.inFlight.size;
    const picks = pickParts(
      sched.filter((f) => active.has(f.id)),
      { maxFiles: Infinity, perFile: c.partsPerUpload, globalCap: this.aimd.cap, inFlight },
    );
    const taken = new Map<string, number[]>();
    for (const id of picks) {
      const rt = this.items.get(id) as UploadRt;
      const used = taken.get(id) ?? [];
      const n = this.pendingParts(rt).find((p) => !used.includes(p));
      if (n === undefined) continue;
      used.push(n);
      taken.set(id, used);
      void this.sendPart(rt, n);
    }
  }

  private pendingParts(rt: UploadRt): number[] {
    const s = rt.session;
    if (!s) return [];
    const out: number[] = [];
    for (let n = 1; n <= s.partCount; n++) if (!s.etags[n] && !rt.inFlight.has(n) && !rt.waiting.has(n)) out.push(n);
    return out;
  }

  // ---------------------------------------------------------------- uploads: protocol

  private async api_(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.apiHttp.request(`${this.config.apiBase}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  }

  private async apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.api_(method, path, body);
    } catch {
      throw new HttpError(0, 'NETWORK', 'Network error');
    }
    if (!res.ok) {
      let code = 'HTTP_ERROR';
      let message = `${method} ${path} failed (${res.status})`;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string; data?: { reason?: string } } };
        code = j.error?.data?.reason ?? j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new HttpError(res.status, code, message, res.headers.get('retry-after'));
    }
    return (await res.json()) as T;
  }

  /** Create (or reuse by fingerprint) the server upload, or re-sync parts after reload / reconnect. */
  private async prepare(rt: UploadRt) {
    rt.preparing = true;
    if (rt.item.status !== 'running') this.setStatus(rt, 'preparing');
    try {
      if (rt.session && rt.needsSync) {
        const synced = await this.syncSession(rt);
        if (!synced) rt.session = undefined;
      }
      if (!rt.session) {
        const body = {
          filename: rt.item.name,
          contentType: rt.item.contentType,
          size: rt.item.size,
          fingerprint: rt.item.fingerprint,
          ...(rt.item.projectId ? { projectId: rt.item.projectId } : {}),
          ...(rt.item.durationMs ? { durationMs: rt.item.durationMs } : {}),
        };
        const r = await this.apiJson<CreateResponse>('POST', '/api/assets/uploads', body);
        rt.session = normalizeCreate(r, rt.item.size);
        rt.item.assetId = rt.session.assetId;
        rt.urls.clear();
      }
      rt.needsSync = false;
      rt.attempts.delete(0);
      this.resetProgressToDone(rt);
      rt.preparing = false;
      if (!this.items.has(rt.item.id)) return;
      await this.persist(rt);
      if (this.runnable(rt)) this.setStatus(rt, 'running');
      this.pump();
    } catch (err) {
      rt.preparing = false;
      if (!this.items.has(rt.item.id)) return;
      this.onRequestError(rt, 0, err);
    }
  }

  /** ListParts on the server; false when the upload is gone (expired or aborted). */
  private async syncSession(rt: UploadRt): Promise<boolean> {
    const s = rt.session!;
    try {
      const r = await this.apiJson<StatusResponse>('GET', `/api/assets/uploads/${encodeURIComponent(s.assetId)}`);
      if (r.status && r.status !== 'uploading') {
        if (r.asset || r.status === 'complete' || r.status === 'processing' || r.status === 'ready') {
          // Completed already (e.g. the tab closed during complete).
          s.etags = Object.fromEntries(Array.from({ length: s.partCount }, (_, i) => [i + 1, 'done']));
          return true;
        }
        return false;
      }
      const etags: Record<number, string> = {};
      for (const p of r.parts ?? []) {
        const n = p.n ?? p.partNumber;
        if (n && p.etag) etags[n] = p.etag;
      }
      s.etags = etags;
      if (r.partSize) s.partSize = r.partSize;
      if (r.partCount) s.partCount = r.partCount;
      if (r.expiresAt) s.expiresAt = toMs(r.expiresAt);
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 405 || err.status === 409 || err.status === 410)) return false;
      throw err;
    }
  }

  /** Presigned URLs for the next window of parts, in one batch. */
  private async ensureUrl(rt: UploadRt, n: number): Promise<string | null> {
    const margin = this.config.urlRefreshMarginMs;
    const valid = (k: number) => {
      const u = rt.urls.get(k);
      return !!u && u.expiresAt - margin > this.now();
    };
    if (rt.proxied) return null;
    while (!valid(n)) {
      if (!rt.urlFetch) {
        const s = rt.session!;
        const window = Math.max(this.config.concurrency.partsPerUpload, this.aimd.cap) * 2;
        const want: number[] = [n];
        for (let k = 1; k <= s.partCount && want.length < window; k++) if (k !== n && !s.etags[k] && !valid(k)) want.push(k);
        rt.urlFetch = (async () => {
          try {
            const r = await this.apiJson<{ urls: Array<{ n?: number; partNumber?: number; url: string; expiresAt?: string | number }> }>(
              'POST',
              `/api/assets/uploads/${encodeURIComponent(s.assetId)}/part-urls`,
              { partNumbers: want.sort((a, b) => a - b) },
            );
            for (const u of r.urls) {
              const k = u.n ?? u.partNumber;
              if (k) rt.urls.set(k, { url: u.url, expiresAt: u.expiresAt ? toMs(u.expiresAt) : this.now() + 3600_000 });
            }
          } catch (err) {
            if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
              rt.proxied = true;
              return;
            }
            if (err instanceof HttpError && err.status === 409) {
              // The upload closed under us (completed elsewhere, aborted, expired): re-sync before going on.
              rt.needsSync = true;
              throw new HttpError(503, 'RESYNC', 'Upload changed on the server');
            }
            throw err;
          } finally {
            rt.urlFetch = undefined;
          }
        })();
      }
      await rt.urlFetch;
      if (rt.proxied) return null;
      if (!valid(n) && !rt.urls.has(n)) throw new HttpError(500, 'NO_URL', 'The server did not sign this part');
      if (!valid(n)) break; // URL returned already near expiry: use it anyway.
    }
    return rt.urls.get(n)!.url;
  }

  private async sendPart(rt: UploadRt, n: number) {
    const s = rt.session!;
    const slot: PartSlot = { abort: new AbortController(), loaded: 0 };
    rt.inFlight.set(n, slot);
    const start = (n - 1) * s.partSize;
    const blob = rt.file!.slice(start, Math.min(rt.item.size, start + s.partSize));
    const armStall = () => {
      if (slot.stall) clearTimeout(slot.stall);
      slot.stall = setTimeout(() => slot.abort.abort('stall'), this.config.stallTimeoutMs);
    };
    try {
      const url = await this.ensureUrl(rt, n);
      if (slot.abort.signal.aborted) throw new AbortError();
      armStall();
      // Presigned R2 URLs are absolute and take no cookies; the development fallback hands out Worker paths.
      const direct = !!url && /^https?:\/\//i.test(url) && !url.startsWith(`${this.config.apiBase}/api/`);
      const target = url ? (direct ? url : `${url.startsWith('/') ? this.config.apiBase : ''}${url}`) : `${this.config.apiBase}/api/assets/uploads/${encodeURIComponent(s.assetId)}/parts/${n}`;
      const res = await this.apiHttp.put(target, blob, {
        signal: slot.abort.signal,
        credentials: direct ? 'omit' : 'include',
        onProgress: (loaded) => {
          slot.loaded = loaded;
          armStall();
          this.onUploadProgress(rt);
        },
      });
      if (slot.stall) clearTimeout(slot.stall);
      if (rt.inFlight.get(n) !== slot) return; // aborted by pause/cancel
      if (res.status >= 200 && res.status < 300) {
        let etag = res.header('etag');
        if (!etag || !direct) {
          try {
            const j = JSON.parse(res.text) as { etag?: string };
            etag = j.etag ?? etag;
          } catch {
            /* keep header */
          }
        }
        if (!etag) throw new HttpError(0, 'NO_ETAG', 'Storage did not expose the part ETag (check bucket CORS ExposeHeaders)');
        rt.inFlight.delete(n);
        s.etags[n] = etag;
        rt.attempts.delete(n);
        this.aimd.onSuccess(blob.size);
        this.resetProgressToDone(rt);
        this.onUploadProgress(rt);
        void this.persist(rt);
        this.pump();
        return;
      }
      if (direct && (res.status === 403 || res.status === 401)) {
        // Presigned URL expired or was rejected: drop it and fetch a fresh batch.
        rt.urls.delete(n);
      }
      throw new HttpError(res.status, res.status === 0 ? 'NETWORK' : 'PART_FAILED', `Part ${n} failed (${res.status})`, res.header('retry-after'));
    } catch (err) {
      if (slot.stall) clearTimeout(slot.stall);
      if (rt.inFlight.get(n) !== slot) return;
      rt.inFlight.delete(n);
      const stalled = slot.abort.signal.aborted && slot.abort.signal.reason === 'stall';
      if (err instanceof AbortError && !stalled) return;
      this.resetProgressToDone(rt);
      this.onRequestError(rt, n, stalled ? new HttpError(0, 'STALLED', 'No progress') : err);
    }
  }

  private onUploadProgress(rt: UploadRt) {
    let inflight = 0;
    for (const sl of rt.inFlight.values()) inflight += sl.loaded;
    const s = rt.session;
    const stored = s ? Object.keys(s.etags).reduce((sum, n) => sum + partBytes(rt.item.size, s.partSize, Number(n)), 0) : 0;
    rt.item.bytesDone = Math.min(rt.item.size, stored + inflight);
    rt.item.speed = rt.meter.sample(rt.item.bytesDone);
    rt.item.eta = etaSeconds(rt.item.size - rt.item.bytesDone, rt.item.speed);
    rt.item.updatedAt = this.now();
    this.broadcast();
  }

  /** Shared retry policy for upload steps (n = 0 is the create/sync step) and download chunks. */
  private onRequestError(rt: Rt, n: number, err: unknown) {
    const e = err instanceof HttpError ? err : new HttpError(0, 'NETWORK', err instanceof Error ? err.message : 'Network error');
    const offline = e.status === 0 && !this.online;
    const retryable = e.status === 0 || isRetryableStatus(e.status) || e.status === 403 || e.code === 'STALLED';
    if (!retryable || e.code === 'NO_ETAG') {
      return this.fail(rt, { code: e.code, message: e.message, status: e.status || undefined });
    }
    if (rt.kind === 'upload' && n > 0 && (isCongestionStatus(e.status) || e.code === 'STALLED')) {
      if (this.aimd.onCongestion()) this.broadcast(true);
    }
    if (offline) {
      // Wait for the network without spending attempts.
      this.onlineListeners.push(() => this.pump());
      this.broadcast(true);
      return;
    }
    const attempt = (rt.attempts.get(n) ?? 0) + 1;
    rt.attempts.set(n, attempt);
    if (attempt >= this.config.retry.maxAttempts) {
      return this.fail(rt, { code: e.code, message: e.message, status: e.status || undefined });
    }
    const delay = retryDelay(attempt, e.retryAfter, this.config.retry, this.now(), this.random);
    rt.item.nextRetryAt = this.now() + delay;
    rt.item.status = 'retrying';
    rt.item.error = { code: e.code, message: e.message, status: e.status || undefined };
    const key = n;
    const prev = rt.waiting.get(key);
    if (prev) clearTimeout(prev);
    rt.waiting.set(
      key,
      setTimeout(() => {
        rt.waiting.delete(key);
        if (rt.item.status === 'retrying') {
          rt.item.status = 'running';
          delete rt.item.error;
        }
        this.pump();
        this.broadcast(true);
      }, delay),
    );
    this.broadcast(true);
  }

  private async complete(rt: UploadRt) {
    if (rt.completing) return;
    rt.completing = true;
    this.setStatus(rt, 'completing');
    const s = rt.session!;
    try {
      const parts = Object.entries(s.etags)
        .map(([n, etag]) => ({ partNumber: Number(n), etag }))
        .sort((a, b) => a.partNumber - b.partNumber);
      let asset: unknown;
      try {
        asset = (await this.apiJson<{ asset?: unknown }>('POST', `/api/assets/uploads/${encodeURIComponent(s.assetId)}/complete`, { parts })).asset;
      } catch (err) {
        // Completed by an earlier attempt whose response was lost.
        if (!(err instanceof HttpError && err.status === 409)) throw err;
      }
      rt.completing = false;
      rt.slot = false;
      rt.file = undefined;
      rt.item.bytesDone = rt.item.size;
      rt.item.persisted = false;
      void this.deps.persistence.deleteBlob(rt.item.id);
      this.setStatus(rt, 'done');
      for (const id of [rt.item.id, ...rt.aliases]) {
        this.emit({ type: 'asset.uploaded', id, assetId: s.assetId, asset, name: rt.item.name, purpose: rt.item.purpose });
      }
      this.emit({ type: 'transfer.done', id: rt.item.id, kind: 'upload', name: rt.item.name });
      this.trimHistory();
      this.pump();
    } catch (err) {
      rt.completing = false;
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        // Server disagrees about parts: re-sync and send what is missing.
        rt.needsSync = true;
        const attempt = (rt.attempts.get(-1) ?? 0) + 1;
        rt.attempts.set(-1, attempt);
        if (attempt >= 3) return this.fail(rt, { code: err.code, message: err.message, status: err.status });
        this.setStatus(rt, 'running');
        this.pump();
        return;
      }
      this.onRequestError(rt, -1, err);
    }
  }

  private trimHistory() {
    const finished = [...this.items.values()].filter((rt) => rt.kind === 'upload' && rt.item.status === 'done').sort((a, b) => b.item.updatedAt - a.item.updatedAt);
    for (const rt of finished.slice(HISTORY_LIMIT)) {
      this.items.delete(rt.item.id);
      void this.deps.persistence.remove(rt.item.id);
    }
  }

  // ---------------------------------------------------------------- downloads

  private async addDownload(port: PortLike, reqId: string, r: DownloadRequest) {
    const key = r.key ?? downloadKey(r.url);
    const existing = [...this.items.values()].find((o): o is DownloadRt => o.kind !== 'upload' && o.session.key === key && o.item.status !== 'canceled');
    if (existing) {
      this.send(port, { type: 'downloadStarted', reqId, id: existing.item.id, deduped: true });
      existing.session.url = r.url; // the newest URL is the freshest signature
      existing.session.lastUsed = this.now();
      if (r.kind === 'download' && existing.item.hidden) {
        existing.item.hidden = false;
        existing.item.kind = 'download';
      }
      existing.requesters.push({ port, reqId, canRefresh: r.canRefresh });
      if (existing.item.status === 'done') {
        void this.deliver(existing);
      } else if (existing.item.status === 'failed') {
        this.retry(existing.item.id);
      } else {
        this.pump();
      }
      this.broadcast(true);
      return;
    }
    const item = this.newItem({
      id: r.id,
      kind: r.kind,
      name: r.filename,
      size: r.size ?? 0,
      url: r.url,
      filename: r.filename,
      hidden: r.hidden ?? r.kind === 'fetch',
    });
    const session: DownloadSession = { url: r.url, key, chunkSize: this.config.chunkSize, done: [], lastUsed: this.now(), store: this.deps.chunks.kind };
    const rt = this.newDownloadRt(item, session);
    rt.requesters.push({ port, reqId, canRefresh: r.canRefresh });
    this.items.set(r.id, rt);
    this.send(port, { type: 'downloadStarted', reqId, id: r.id, deduped: false });
    await this.persist(rt);
    this.pump();
    this.broadcast(true);
  }

  private chunkCount(rt: DownloadRt): number | null {
    const s = rt.session;
    if (s.ranged === false) return 1;
    if (s.total == null) return null;
    return Math.max(1, Math.ceil(s.total / s.chunkSize));
  }

  private pumpDownloads() {
    const c = this.config.concurrency;
    const downloads = [...this.items.values()].filter((rt): rt is DownloadRt => rt.kind !== 'upload' && this.runnable(rt) && !rt.assembling);
    const sched: SchedFile[] = downloads.map((rt) => ({
      id: rt.item.id,
      size: rt.item.size || Number.MAX_SAFE_INTEGER,
      priority: rt.item.kind === 'fetch' ? 'high' : rt.item.priority,
      createdAt: rt.item.createdAt,
      started: rt.slot,
      inFlight: rt.inFlight.size,
      pending: this.pendingChunks(rt).length,
    }));
    const active = new Set(activeFiles(sched, c.maxDownloads).map((f) => f.id));
    let inFlight = 0;
    for (const rt of this.items.values()) if (rt.kind !== 'upload') inFlight += rt.inFlight.size;
    for (const rt of downloads) {
      if (!active.has(rt.item.id)) continue;
      rt.slot = true;
      if (rt.item.status === 'queued') this.setStatus(rt, 'running');
      const count = this.chunkCount(rt);
      if (count !== null && rt.session.done.length >= count && rt.inFlight.size === 0) void this.finishDownload(rt);
    }
    const picks = pickParts(
      sched.filter((f) => active.has(f.id)),
      { maxFiles: Infinity, perFile: c.chunksPerDownload, globalCap: c.downloadChunks, inFlight },
    );
    const taken = new Map<string, number[]>();
    for (const id of picks) {
      const rt = this.items.get(id) as DownloadRt;
      const used = taken.get(id) ?? [];
      const i = this.pendingChunks(rt).find((p) => !used.includes(p));
      if (i === undefined) continue;
      used.push(i);
      taken.set(id, used);
      void this.fetchChunk(rt, i);
    }
  }

  private pendingChunks(rt: DownloadRt): number[] {
    const count = this.chunkCount(rt);
    if (count === null) {
      // Size unknown: probe with chunk 0 only.
      return rt.inFlight.size || rt.waiting.size ? [] : [0];
    }
    const out: number[] = [];
    for (let i = 0; i < count; i++) if (!rt.session.done.includes(i) && !rt.inFlight.has(i) && !rt.waiting.has(i)) out.push(i);
    return out;
  }

  private async fetchChunk(rt: DownloadRt, i: number) {
    const s = rt.session;
    const slot: PartSlot = { abort: new AbortController(), loaded: 0 };
    rt.inFlight.set(i, slot);
    const armStall = () => {
      if (slot.stall) clearTimeout(slot.stall);
      slot.stall = setTimeout(() => slot.abort.abort('stall'), this.config.stallTimeoutMs);
    };
    try {
      const start = i * s.chunkSize;
      const end = s.total != null ? Math.min(s.total, start + s.chunkSize) - 1 : start + s.chunkSize - 1;
      const headers: Record<string, string> = { range: `bytes=${start}-${end}` };
      const validator = s.etag ?? s.lastModified;
      if (validator && i > 0) headers['if-range'] = validator;
      else if (validator && s.total != null) headers['if-range'] = validator;
      armStall();
      let res: Response;
      try {
        res = await this.deps.http.request(s.url, { headers, signal: slot.abort.signal, credentials: sameOrigin(s.url) ? 'include' : 'omit' });
      } catch (err) {
        if (slot.abort.signal.aborted) throw slot.abort.signal.reason === 'stall' ? new HttpError(0, 'STALLED', 'No progress') : new AbortError();
        throw new HttpError(0, 'NETWORK', err instanceof Error ? err.message : 'Network error');
      }
      if (res.status === 401 || res.status === 403 || res.status === 410) {
        slot.abort.abort();
        rt.inFlight.delete(i);
        if (slot.stall) clearTimeout(slot.stall);
        const ok = await this.refreshUrl(rt);
        if (!ok) return this.fail(rt, { code: 'URL_EXPIRED', message: 'The download link expired', status: res.status });
        this.pump();
        return;
      }
      if (res.status === 200) {
        // Server ignored Range, or If-Range failed because the file changed.
        if (s.done.length > 0 || i > 0) {
          slot.abort.abort();
          rt.inFlight.delete(i);
          if (slot.stall) clearTimeout(slot.stall);
          this.abortAll(rt);
          await this.deps.chunks.delete(rt.item.id);
          s.done = [];
          s.total = undefined;
          s.etag = undefined;
          s.lastModified = undefined;
          s.ranged = undefined;
          this.resetProgressToDone(rt);
          void this.persist(rt);
          this.pump();
          return;
        }
        s.ranged = false;
        s.etag = res.headers.get('etag');
        s.lastModified = res.headers.get('last-modified');
        const len = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(len)) {
          s.total = len;
          rt.item.size = len;
        }
      } else if (res.status === 206) {
        const cr = parseContentRange(res.headers.get('content-range'));
        if (cr?.total != null && s.total == null) {
          s.total = cr.total;
          rt.item.size = cr.total;
          s.ranged = true;
        }
        if (!s.etag) s.etag = res.headers.get('etag');
        if (!s.lastModified) s.lastModified = res.headers.get('last-modified');
      } else if (res.status === 416 && s.total != null && s.done.length >= (this.chunkCount(rt) ?? Infinity)) {
        rt.inFlight.delete(i);
        if (slot.stall) clearTimeout(slot.stall);
        this.pump();
        return;
      } else {
        throw new HttpError(res.status, 'DOWNLOAD_FAILED', `Download failed (${res.status})`, res.headers.get('retry-after'));
      }
      const blob = await this.readBody(res, slot, armStall, () => this.onDownloadProgress(rt));
      if (slot.stall) clearTimeout(slot.stall);
      if (rt.inFlight.get(i) !== slot) return;
      const expected = s.ranged === false ? s.total ?? blob.size : chunkBytes(s.total ?? 0, s.chunkSize, i);
      if (s.total != null && blob.size !== expected) throw new HttpError(0, 'SHORT_READ', `Chunk ${i} was ${blob.size} bytes, expected ${expected}`);
      if (s.total == null) s.total = blob.size;
      await this.deps.chunks.put(rt.item.id, s.ranged === false ? 0 : i, blob);
      rt.inFlight.delete(i);
      if (!s.done.includes(i)) s.done.push(i);
      rt.attempts.delete(i);
      this.resetProgressToDone(rt);
      this.onDownloadProgress(rt);
      void this.persist(rt);
      this.pump();
    } catch (err) {
      if (slot.stall) clearTimeout(slot.stall);
      if (rt.inFlight.get(i) !== slot) return;
      rt.inFlight.delete(i);
      const stalled = slot.abort.signal.aborted && slot.abort.signal.reason === 'stall';
      if (err instanceof AbortError && !stalled) return;
      this.resetProgressToDone(rt);
      this.onRequestError(rt, i, stalled ? new HttpError(0, 'STALLED', 'No progress') : err);
    }
  }

  private async readBody(res: Response, slot: PartSlot, onData: () => void, onProgress: () => void): Promise<Blob> {
    if (!res.body) return res.blob();
    const reader = res.body.getReader();
    const parts: BlobPart[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (slot.abort.signal.aborted) throw slot.abort.signal.reason === 'stall' ? new HttpError(0, 'STALLED', 'No progress') : new AbortError();
        parts.push(value as Uint8Array<ArrayBuffer>);
        slot.loaded += value.byteLength;
        onData();
        onProgress();
      }
    } catch (err) {
      if (err instanceof HttpError || err instanceof AbortError) throw err;
      if (slot.abort.signal.aborted) throw slot.abort.signal.reason === 'stall' ? new HttpError(0, 'STALLED', 'No progress') : new AbortError();
      throw new HttpError(0, 'NETWORK', 'Connection lost');
    }
    return new Blob(parts);
  }

  private onDownloadProgress(rt: DownloadRt) {
    let inflight = 0;
    for (const sl of rt.inFlight.values()) inflight += sl.loaded;
    const s = rt.session;
    const stored = s.done.reduce((sum, i) => sum + chunkBytes(s.total ?? rt.item.size, s.chunkSize, i), 0);
    const total = s.total ?? rt.item.size;
    rt.item.bytesDone = total ? Math.min(total, stored + inflight) : stored + inflight;
    rt.item.speed = rt.meter.sample(rt.item.bytesDone);
    rt.item.eta = total ? etaSeconds(total - rt.item.bytesDone, rt.item.speed) : null;
    rt.item.updatedAt = this.now();
    this.broadcast();
  }

  /** Ask a requesting tab to mint a fresh signed URL. */
  private refreshUrl(rt: DownloadRt): Promise<boolean> {
    if (rt.refreshing) return rt.refreshing;
    rt.refreshing = (async () => {
      for (const r of rt.requesters.filter((x) => x.canRefresh)) {
        const reqId = `rf${++this.refreshSeq}`;
        const url = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            this.refreshWaiters.delete(reqId);
            resolve(null);
          }, 30_000);
          this.refreshWaiters.set(reqId, (u) => {
            clearTimeout(timer);
            resolve(u);
          });
          this.send(r.port, { type: 'refreshUrl', reqId, id: rt.item.id, url: rt.session.url });
        });
        if (url) {
          rt.session.url = url;
          rt.item.url = url;
          void this.persist(rt);
          return true;
        }
      }
      return false;
    })().finally(() => {
      rt.refreshing = undefined;
    });
    return rt.refreshing;
  }

  private async finishDownload(rt: DownloadRt) {
    if (rt.assembling) return;
    rt.assembling = true;
    rt.slot = false;
    rt.item.bytesDone = rt.session.total ?? rt.item.bytesDone;
    rt.item.size = rt.session.total ?? rt.item.size;
    this.setStatus(rt, 'done');
    rt.assembling = false;
    this.emit({ type: 'transfer.done', id: rt.item.id, kind: rt.item.kind, name: rt.item.name });
    await this.deliver(rt);
    await this.evict();
    this.pump();
  }

  private async assemble(rt: DownloadRt): Promise<Blob> {
    const count = this.chunkCount(rt) ?? 1;
    const blob = await this.deps.chunks.assemble(rt.item.id, count);
    return rt.item.contentType ? blob.slice(0, blob.size, rt.item.contentType) : blob;
  }

  private async deliver(rt: DownloadRt) {
    const waiting = rt.requesters.splice(0);
    if (!waiting.length) return;
    rt.session.lastUsed = this.now();
    void this.persist(rt);
    try {
      const blob = await this.assemble(rt);
      for (const r of waiting) this.send(r.port, { type: 'blob', reqId: r.reqId, id: rt.item.id, blob, filename: rt.item.filename });
    } catch {
      // Chunks evicted or storage cleared: fetch again.
      rt.requesters.push(...waiting);
      rt.session.done = [];
      rt.item.bytesDone = 0;
      this.setStatus(rt, 'queued');
      this.pump();
    }
  }

  private async sendBlob(port: PortLike, reqId: string, id: string) {
    const rt = this.items.get(id);
    if (!rt || rt.kind === 'upload' || rt.item.status !== 'done') {
      return this.send(port, { type: 'blob', reqId, id, blob: null, error: { code: 'NOT_READY', message: 'Not downloaded' } });
    }
    rt.requesters.push({ port, reqId, canRefresh: false });
    await this.deliver(rt);
  }

  /** LRU over finished downloads and cache fills; never evicts what is running or was used in the last minute. */
  private async evict() {
    const done = [...this.items.values()].filter((rt): rt is DownloadRt => rt.kind !== 'upload' && rt.item.status === 'done');
    let total = done.reduce((sum, rt) => sum + (rt.session.total ?? rt.item.size), 0);
    if (total <= this.config.cacheBudgetBytes) return;
    const t = this.now();
    for (const rt of done.sort((a, b) => a.session.lastUsed - b.session.lastUsed)) {
      if (total <= this.config.cacheBudgetBytes) break;
      if (t - rt.session.lastUsed < 60_000 || rt.requesters.length) continue;
      total -= rt.session.total ?? rt.item.size;
      this.items.delete(rt.item.id);
      await this.deps.chunks.delete(rt.item.id);
      await this.deps.persistence.remove(rt.item.id);
    }
    this.broadcast(true);
  }

  // ---------------------------------------------------------------- testing hooks

  get uploadCap() {
    return this.aimd.cap;
  }

  /** For tests: priority bump without a port. */
  prioritize(id: string, priority: Priority) {
    const rt = this.items.get(id);
    if (rt) rt.item.priority = priority;
    this.pump();
  }
}

// ------------------------------------------------------------------ helpers

interface CreateResponse {
  assetId: string;
  uploadId?: string;
  key?: string;
  partSize?: number;
  partCount?: number;
  expiresAt?: string | number;
  /** New contract: parts the server already has. Old contract: part count. */
  parts?: number | Array<{ n?: number; partNumber?: number; size?: number; etag?: string }>;
}

interface StatusResponse {
  status?: string;
  asset?: unknown;
  partSize?: number;
  partCount?: number;
  expiresAt?: string | number;
  parts?: Array<{ n?: number; partNumber?: number; size?: number; etag?: string }>;
}

function normalizeCreate(r: CreateResponse, size: number): UploadSession {
  const partSize = r.partSize ?? 8 * 1024 * 1024;
  const partCount = r.partCount ?? (typeof r.parts === 'number' ? r.parts : Math.max(1, Math.ceil(size / partSize)));
  const etags: Record<number, string> = {};
  if (Array.isArray(r.parts)) {
    for (const p of r.parts) {
      const n = p.n ?? p.partNumber;
      if (n && p.etag) etags[n] = p.etag;
    }
  }
  return { assetId: r.assetId, uploadId: r.uploadId, partSize, partCount, etags, expiresAt: r.expiresAt ? toMs(r.expiresAt) : undefined };
}

function toMs(v: string | number): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? Date.now() + 3600_000 : n;
}

export function partBytes(size: number, partSize: number, n: number): number {
  const parts = Math.max(1, Math.ceil(size / partSize));
  if (n < 1 || n > parts) return 0;
  return n < parts ? partSize : size - partSize * (parts - 1);
}

export function chunkBytes(total: number, chunkSize: number, i: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(chunkSize, total - i * chunkSize));
}

function sameOrigin(url: string): boolean {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc) return false;
    return new URL(url, loc.href).origin === loc.origin;
  } catch {
    return false;
  }
}
