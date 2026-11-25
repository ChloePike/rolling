/**
 * Persistence for the transfer queue (D-011): item records and upload
 * sessions in IndexedDB, the picked File itself (≤ persistBlobMaxBytes) so an
 * upload resumes after reload, and download chunks in OPFS with an IndexedDB
 * fallback. Every call fails soft: no storage just means no resume.
 */
import type { TransferItem } from './types';

export interface UploadSession {
  assetId: string;
  uploadId?: string;
  partSize: number;
  partCount: number;
  /** Part number → ETag of parts the server has. */
  etags: Record<number, string>;
  expiresAt?: number;
}

export interface DownloadSession {
  url: string;
  key: string;
  etag?: string | null;
  lastModified?: string | null;
  total?: number;
  chunkSize: number;
  /** Chunk indexes (0-based) stored in the chunk store. */
  done: number[];
  /** false when the server ignored Range and sent the whole body. */
  ranged?: boolean;
  lastUsed: number;
  /** Where chunks live. */
  store: 'opfs' | 'idb' | 'memory';
}

export interface PersistedRecord {
  id: string;
  /** Engine instance that owns it (fallback mode: one engine per tab). */
  owner: string;
  item: TransferItem;
  upload?: UploadSession;
  download?: DownloadSession;
}

export interface Persistence {
  loadAll(): Promise<PersistedRecord[]>;
  save(record: PersistedRecord): Promise<void>;
  remove(id: string): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<boolean>;
  getBlob(id: string): Promise<Blob | undefined>;
  deleteBlob(id: string): Promise<void>;
}

export interface ChunkStore {
  readonly kind: 'opfs' | 'idb' | 'memory';
  put(id: string, n: number, blob: Blob): Promise<void>;
  get(id: string, n: number): Promise<Blob | undefined>;
  /** One Blob of chunks 0..count-1 (lazy where the backend allows). */
  assemble(id: string, count: number): Promise<Blob>;
  delete(id: string): Promise<void>;
}

// ------------------------------------------------------------------ memory

export class MemoryPersistence implements Persistence {
  records = new Map<string, PersistedRecord>();
  blobs = new Map<string, Blob>();
  async loadAll() {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  async save(record: PersistedRecord) {
    this.records.set(record.id, structuredClone(record));
  }
  async remove(id: string) {
    this.records.delete(id);
    this.blobs.delete(id);
  }
  async putBlob(id: string, blob: Blob) {
    this.blobs.set(id, blob);
    return true;
  }
  async getBlob(id: string) {
    return this.blobs.get(id);
  }
  async deleteBlob(id: string) {
    this.blobs.delete(id);
  }
}

export class MemoryChunkStore implements ChunkStore {
  readonly kind = 'memory' as const;
  chunks = new Map<string, Blob>();
  async put(id: string, n: number, blob: Blob) {
    this.chunks.set(`${id}:${n}`, blob);
  }
  async get(id: string, n: number) {
    return this.chunks.get(`${id}:${n}`);
  }
  async assemble(id: string, count: number) {
    const parts: Blob[] = [];
    for (let n = 0; n < count; n++) {
      const b = this.chunks.get(`${id}:${n}`);
      if (!b) throw new Error(`Missing chunk ${n}`);
      parts.push(b);
    }
    return new Blob(parts);
  }
  async delete(id: string) {
    for (const k of [...this.chunks.keys()]) if (k.startsWith(`${id}:`)) this.chunks.delete(k);
  }
}

// ------------------------------------------------------------------ IndexedDB

const DB_NAME = 'rolling-transfers';
const DB_VERSION = 1;
const RECORDS = 'records';
const BLOBS = 'blobs';
const CHUNKS = 'chunks';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

export function openTransfersDb(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (!factory) return resolve(null);
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export class IdbPersistence implements Persistence {
  constructor(private readonly db: IDBDatabase) {}

  async loadAll(): Promise<PersistedRecord[]> {
    try {
      return await req(this.db.transaction(RECORDS, 'readonly').objectStore(RECORDS).getAll());
    } catch {
      return [];
    }
  }
  async save(record: PersistedRecord) {
    try {
      const tx = this.db.transaction(RECORDS, 'readwrite');
      tx.objectStore(RECORDS).put(record);
      await done(tx);
    } catch {
      /* storage full or blocked: resume will not survive reload */
    }
  }
  async remove(id: string) {
    try {
      const tx = this.db.transaction([RECORDS, BLOBS], 'readwrite');
      tx.objectStore(RECORDS).delete(id);
      tx.objectStore(BLOBS).delete(id);
      await done(tx);
    } catch {
      /* ignore */
    }
  }
  async putBlob(id: string, blob: Blob) {
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite');
      tx.objectStore(BLOBS).put(blob, id);
      await done(tx);
      return true;
    } catch {
      return false;
    }
  }
  async getBlob(id: string) {
    try {
      return (await req(this.db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(id))) as Blob | undefined;
    } catch {
      return undefined;
    }
  }
  async deleteBlob(id: string) {
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite');
      tx.objectStore(BLOBS).delete(id);
      await done(tx);
    } catch {
      /* ignore */
    }
  }
}

export class IdbChunkStore implements ChunkStore {
  readonly kind = 'idb' as const;
  constructor(private readonly db: IDBDatabase) {}
  async put(id: string, n: number, blob: Blob) {
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).put(blob, `${id}:${n}`);
    await done(tx);
  }
  async get(id: string, n: number) {
    return (await req(this.db.transaction(CHUNKS, 'readonly').objectStore(CHUNKS).get(`${id}:${n}`))) as Blob | undefined;
  }
  async assemble(id: string, count: number) {
    const parts: Blob[] = [];
    for (let n = 0; n < count; n++) {
      const b = await this.get(id, n);
      if (!b) throw new Error(`Missing chunk ${n}`);
      parts.push(b);
    }
    return new Blob(parts);
  }
  async delete(id: string) {
    try {
      const tx = this.db.transaction(CHUNKS, 'readwrite');
      tx.objectStore(CHUNKS).delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
      await done(tx);
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ OPFS

/** One file per chunk under `/transfers/<id>/<n>`: writes are whole files, so a crash never leaves a half chunk counted as done. */
export class OpfsChunkStore implements ChunkStore {
  readonly kind = 'opfs' as const;
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsChunkStore | null> {
    try {
      const storage = (globalThis.navigator as Navigator | undefined)?.storage;
      if (!storage?.getDirectory) return null;
      const root = await storage.getDirectory();
      const dir = await root.getDirectoryHandle('transfers', { create: true });
      // Probe: some browsers expose OPFS but not writable streams in this context.
      const probe = await dir.getFileHandle('.probe', { create: true });
      if (typeof (probe as FileSystemFileHandle & { createWritable?: unknown }).createWritable !== 'function') return null;
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      return new OpfsChunkStore(dir);
    } catch {
      return null;
    }
  }

  private async dir(id: string, create: boolean) {
    return this.root.getDirectoryHandle(id, { create });
  }

  async put(id: string, n: number, blob: Blob) {
    const dir = await this.dir(id, true);
    const tmp = await dir.getFileHandle(`${n}.part`, { create: true });
    const w = await tmp.createWritable();
    await w.write(blob);
    await w.close();
    // Rename is not universally available; write the final file directly when it is not.
    const handle = tmp as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
    if (typeof handle.move === 'function') {
      try {
        await dir.removeEntry(String(n)).catch(() => undefined);
        await handle.move(String(n));
        return;
      } catch {
        /* fall through */
      }
    }
    const fin = await dir.getFileHandle(String(n), { create: true });
    const w2 = await fin.createWritable();
    await w2.write(blob);
    await w2.close();
    await dir.removeEntry(`${n}.part`).catch(() => undefined);
  }

  async get(id: string, n: number) {
    try {
      const dir = await this.dir(id, false);
      return await (await dir.getFileHandle(String(n))).getFile();
    } catch {
      return undefined;
    }
  }

  async assemble(id: string, count: number) {
    const parts: Blob[] = [];
    for (let n = 0; n < count; n++) {
      const f = await this.get(id, n);
      if (!f) throw new Error(`Missing chunk ${n}`);
      parts.push(f);
    }
    return new Blob(parts);
  }

  async delete(id: string) {
    await this.root.removeEntry(id, { recursive: true }).catch(() => undefined);
  }
}
