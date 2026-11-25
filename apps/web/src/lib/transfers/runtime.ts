/**
 * Builds a TransferEngine with browser storage and network for whichever
 * context hosts it (SharedWorker, dedicated Worker or the main thread).
 */
import type { TransfersConfig } from './config';
import { TransferEngine } from './engine';
import { browserHttp, type Http } from './http';
import { createMockHttp } from './mockApi';
import { IdbChunkStore, IdbPersistence, MemoryChunkStore, MemoryPersistence, OpfsChunkStore, openTransfersDb, type ChunkStore } from './store';
import type { TransportMode } from './types';

const OWNER_LOCK = 'rolling-transfers-owner:';
const ADOPT_LOCK = 'rolling-transfers-adopt';

function locks(): LockManager | null {
  return (globalThis.navigator as Navigator | undefined)?.locks ?? null;
}

const isLocalHost = () => {
  const host = (globalThis as { location?: Location }).location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
};

/** 'auto': on localhost with no API Worker answering `/api/health`, serve uploads from the dev mock. */
export async function resolveApi(config: TransfersConfig): Promise<{ api: 'real' | 'mock'; http: Http }> {
  const mock = () => ({ api: 'mock' as const, http: createMockHttp({ passthrough: browserHttp }) });
  if (config.api === 'mock') return mock();
  if (config.api === 'real' || !isLocalHost()) return { api: 'real', http: browserHttp };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${config.apiBase}/api/health`, { signal: ctrl.signal, credentials: 'include' });
    clearTimeout(t);
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (res.ok && body?.ok) return { api: 'real', http: browserHttp };
  } catch {
    /* no API */
  }
  return mock();
}

export async function createEngine(mode: TransportMode): Promise<TransferEngine> {
  const owner = `eng_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const db = await openTransfersDb();
  const persistence = db ? new IdbPersistence(db) : new MemoryPersistence();
  let chunks: ChunkStore | null = await OpfsChunkStore.open();
  if (!chunks) chunks = db ? new IdbChunkStore(db) : new MemoryChunkStore();
  const lm = locks();
  if (lm) {
    // Held for this engine's lifetime: tells other engines its records are not orphans.
    void lm.request(`${OWNER_LOCK}${owner}`, () => new Promise<void>(() => undefined)).catch(() => undefined);
  }
  return new TransferEngine({
    http: browserHttp,
    persistence,
    chunks,
    owner,
    mode,
    resolveApi,
    online: (globalThis.navigator as Navigator | undefined)?.onLine ?? true,
    withAdoptLock: lm ? async (fn) => void (await lm.request(ADOPT_LOCK, fn)) : undefined,
    // Granted only after the other engine released its lifetime lock.
    whenOwnerGone: lm ? (other, cb) => void lm.request(`${OWNER_LOCK}${other}`, async () => undefined).then(cb, () => undefined) : undefined,
    liveOwners: lm
      ? async () => {
          const state = await lm.query();
          return new Set((state.held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith(OWNER_LOCK)).map((n) => n.slice(OWNER_LOCK.length)));
        }
      : undefined,
  });
}
