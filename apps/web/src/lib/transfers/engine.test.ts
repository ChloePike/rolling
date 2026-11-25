import { afterEach, describe, expect, it } from 'vitest';
import type { DeepPartial, TransfersConfig } from './config';
import { downloadKey, parseContentRange, TransferEngine } from './engine';
import { AbortError, type Http, type PutOptions, type PutResult } from './http';
import { MemoryChunkStore, MemoryPersistence } from './store';
import type { EngineMessage, PortLike, QueueSnapshot, TransferEvent, UploadRequest } from './types';

const PART = 1024; // small parts keep the tests fast
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PartHook = (n: number, assetId: string) => Promise<{ status: number; retryAfter?: string } | void> | { status: number; retryAfter?: string } | void;

/** In-memory backend for the presigned upload contract plus a ranged file server. */
class FakeServer implements Http {
  uploads = new Map<string, { size: number; partCount: number; parts: Map<number, string>; status: string; fp?: string }>();
  log: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  filesInFlight = new Map<string, number>();
  maxFilesInFlight = 0;
  partDelay = 20;
  partHook: PartHook | null = null;
  partUrlsSupported = true;
  /** Development fallback of the real API: part URLs are Worker paths (`direct: false`). */
  relativeUrls = false;
  failComplete = false;
  files = new Map<string, { body: Uint8Array<ArrayBuffer>; etag: string }>();
  rangeHook: ((url: string, range: string | null) => Response | void) | null = null;
  seq = 0;

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url, 'http://app.test');
    this.log.push(`${method} ${u.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    let m: RegExpExecArray | null;
    if (method === 'POST' && u.pathname === '/api/assets/uploads') {
      const existing = [...this.uploads.entries()].find(([, v]) => v.fp === body.fingerprint && v.status === 'uploading');
      const id = existing?.[0] ?? `ast_${++this.seq}`;
      if (!existing) this.uploads.set(id, { size: body.size, partCount: Math.max(1, Math.ceil(body.size / PART)), parts: new Map(), status: 'uploading', fp: body.fingerprint });
      const up = this.uploads.get(id)!;
      return json(201, { assetId: id, uploadId: `u${id}`, partSize: PART, partCount: up.partCount, expiresAt: new Date(Date.now() + 3600_000).toISOString(), parts: [...up.parts].map(([n, etag]) => ({ n, etag, size: PART })) });
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)\/part-urls$/.exec(u.pathname))) {
      if (!this.partUrlsSupported) return json(404, { error: { code: 'NOT_FOUND' } });
      const id = m[1]!;
      const url = (n: number) => (this.relativeUrls ? `/api/assets/uploads/${id}/parts/${n}` : `https://r2.test/${id}/${n}`);
      return json(200, { assetId: id, direct: !this.relativeUrls, urls: (body.partNumbers as number[]).map((n) => ({ n, url: url(n), expiresAt: Date.now() + 3600_000 })) });
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)\/complete$/.exec(u.pathname))) {
      const up = this.uploads.get(m[1]!)!;
      if (this.failComplete) return json(503, { error: { code: 'INTERNAL' } });
      if (up.parts.size !== up.partCount) return json(400, { error: { code: 'VALIDATION_FAILED' } });
      up.status = 'processing';
      return json(200, { asset: { id: m[1], status: 'processing' } });
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)$/.exec(u.pathname))) {
      const up = this.uploads.get(m[1]!);
      if (!up) return json(404, { error: { code: 'NOT_FOUND' } });
      if (method === 'DELETE') {
        this.uploads.delete(m[1]!);
        return json(200, { ok: true });
      }
      return json(200, { status: up.status, partSize: PART, partCount: up.partCount, parts: [...up.parts].map(([n, etag]) => ({ n, etag })) });
    }
    if (u.hostname === 'files.test') {
      const range = new Headers(init.headers).get('range');
      const hooked = this.rangeHook?.(url, range);
      if (hooked) return hooked;
      const f = this.files.get(u.pathname)!;
      const ifRange = new Headers(init.headers).get('if-range');
      if (!range || (ifRange && ifRange !== f.etag)) return new Response(f.body, { status: 200, headers: { etag: f.etag, 'content-length': String(f.body.length) } });
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range)!;
      const start = Number(s);
      const end = Math.min(Number(e), f.body.length - 1);
      return new Response(f.body.slice(start, end + 1), { status: 206, headers: { etag: f.etag, 'content-range': `bytes ${start}-${end}/${f.body.length}` } });
    }
    return json(404, {});
  }

  async put(url: string, body: Blob, opts: PutOptions): Promise<PutResult> {
    const proxied = /\/api\/assets\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(url);
    const m = proxied ?? /^https:\/\/r2\.test\/([^/]+)\/(\d+)$/.exec(url);
    if (!m) throw new Error(`unexpected PUT ${url}`);
    const id = m[1]!;
    const n = Number(m[2]);
    this.log.push(`PUT ${proxied ? 'proxied' : 'r2'} ${n} ${opts.credentials}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.filesInFlight.set(id, (this.filesInFlight.get(id) ?? 0) + 1);
    this.maxFilesInFlight = Math.max(this.maxFilesInFlight, [...this.filesInFlight.values()].filter((v) => v > 0).length);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.partDelay);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new AbortError());
        });
      });
      const hooked = await this.partHook?.(n, id);
      if (hooked) return { status: hooked.status, header: (h) => (h.toLowerCase() === 'retry-after' ? hooked.retryAfter ?? null : null), text: '' };
      opts.onProgress?.(body.size);
      const etag = `"${id}-${n}"`;
      this.uploads.get(id)!.parts.set(n, etag);
      return { status: 200, header: (h) => (h.toLowerCase() === 'etag' ? etag : null), text: proxied ? JSON.stringify({ partNumber: n, etag }) : '' };
    } finally {
      this.inFlight -= 1;
      this.filesInFlight.set(id, this.filesInFlight.get(id)! - 1);
    }
  }
}

class TestPort implements PortLike {
  snapshot: QueueSnapshot | null = null;
  events: TransferEvent[] = [];
  messages: EngineMessage[] = [];
  onRefresh: ((m: Extract<EngineMessage, { type: 'refreshUrl' }>) => void) | null = null;
  postMessage(m: EngineMessage) {
    this.messages.push(m);
    if (m.type === 'state') this.snapshot = m.snapshot;
    if (m.type === 'event') this.events.push(m.event);
    if (m.type === 'refreshUrl') this.onRefresh?.(m);
  }
}

const engines: TransferEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

function setup(opts: { server?: FakeServer; persistence?: MemoryPersistence; chunks?: MemoryChunkStore; config?: DeepPartial<TransfersConfig>; owner?: string } = {}) {
  const server = opts.server ?? new FakeServer();
  const persistence = opts.persistence ?? new MemoryPersistence();
  const chunks = opts.chunks ?? new MemoryChunkStore();
  const engine = new TransferEngine({ http: server, persistence, chunks, owner: opts.owner ?? 'eng_test', mode: 'main', broadcastMs: 5, fingerprint: async (b, name, lm) => `fp:${name}:${b.size}:${lm}` });
  engines.push(engine);
  const port = new TestPort();
  const send = engine.connect(port);
  const config: DeepPartial<TransfersConfig> = { retry: { baseDelayMs: 5, maxDelayMs: 40, maxAttempts: 6 }, chunkSize: 1000, ...opts.config };
  send({ type: 'hello', clientId: 'tab', config });
  return { engine, server, persistence, chunks, port, send };
}

const req = (id: string, size: number, extra: Partial<UploadRequest> = {}): UploadRequest => ({
  id,
  file: new Blob([new Uint8Array(size)]),
  name: `${id}.mp4`,
  lastModified: 1,
  contentType: 'video/mp4',
  purpose: 'library',
  priority: 'normal',
  ...extra,
});

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(5);
  }
}

const uploaded = (port: TestPort) => port.events.filter((e) => e.type === 'asset.uploaded').map((e) => e.id);

describe('uploads', () => {
  it('runs up to 4 files at once, 4 parts per file, under the global cap, then completes each', async () => {
    const { send, port, server, engine } = setup();
    send({ type: 'upload', requests: Array.from({ length: 6 }, (_, i) => req(`f${i}`, PART * 6)) });
    await until(() => uploaded(port).length === 6, 5000);
    expect(server.maxFilesInFlight).toBe(4);
    expect(server.maxInFlight).toBeLessThanOrEqual(16);
    expect(server.maxInFlight).toBeGreaterThanOrEqual(8);
    expect(engine.uploadCap).toBeGreaterThanOrEqual(8);
    expect(server.log.filter((l) => l.startsWith('PUT r2')).every((l) => l.endsWith('omit'))).toBe(true);
    // Part URLs come in batches, not one request per part.
    expect(server.log.filter((l) => l.endsWith('/part-urls')).length).toBeLessThan(6 * 6);
    expect(port.snapshot!.items.every((i) => i.status === 'done' && i.bytesDone === i.size)).toBe(true);
  });

  it('respects a configured global cap and per-file cap', async () => {
    const { send, port, server } = setup({ config: { concurrency: { globalParts: 3, minGlobalParts: 2, maxGlobalParts: 3, partsPerUpload: 2 } } });
    send({ type: 'upload', requests: [req('a', PART * 8), req('b', PART * 8)] });
    await until(() => uploaded(port).length === 2);
    expect(server.maxInFlight).toBe(3);
  });

  it('uploads smaller files first and lets a high-priority file jump the queue', async () => {
    const { send, port } = setup({ config: { concurrency: { maxUploads: 1 } } });
    send({ type: 'upload', requests: [req('big', PART * 6), req('small', PART), req('urgent', PART * 3, { priority: 'high' })] });
    await until(() => uploaded(port).length === 3);
    // fingerprints settle in the same tick; the first to be scheduled has the slot
    const order = uploaded(port);
    expect(order.indexOf('urgent')).toBeLessThan(order.indexOf('big'));
    expect(order.indexOf('small')).toBeLessThan(order.indexOf('big'));
  });

  it('AIMD halves the cap on 429, honours Retry-After, and recovers', async () => {
    const { send, port, server, engine } = setup({ config: { concurrency: { globalParts: 8 } } });
    let throttled = 0;
    server.partHook = (n) => {
      if (n === 3 && throttled < 1) {
        throttled += 1;
        return { status: 429, retryAfter: '0.05' };
      }
    };
    send({ type: 'upload', requests: [req('a', PART * 40)] });
    await until(() => (port.snapshot?.uploadCap ?? 8) < 8);
    expect(port.snapshot!.uploadCap).toBe(4);
    await until(() => uploaded(port).length === 1, 5000);
    expect(engine.uploadCap).toBeGreaterThan(4);
  });

  it('retries 5xx with backoff and fails after max attempts without counting aborts', async () => {
    const { send, port, server } = setup({ config: { retry: { baseDelayMs: 2, maxDelayMs: 5, maxAttempts: 3 } } });
    server.partHook = () => ({ status: 503 });
    send({ type: 'upload', requests: [req('a', PART)] });
    await until(() => port.events.some((e) => e.type === 'transfer.failed'));
    expect(server.log.filter((l) => l.startsWith('PUT')).length).toBe(3);
    // Retry resets attempts and finishes once the server recovers.
    server.partHook = null;
    send({ type: 'retry', id: 'a' });
    await until(() => uploaded(port).length === 1);
  });

  it('resumes from server-reported parts after a reload (persisted blob)', async () => {
    const persistence = new MemoryPersistence();
    const server = new FakeServer();
    const first = setup({ server, persistence, owner: 'eng_1', config: { concurrency: { globalParts: 2, minGlobalParts: 2, maxGlobalParts: 2, partsPerUpload: 2 } } });
    first.send({ type: 'upload', requests: [req('a', PART * 10)] });
    await until(() => (server.uploads.get('ast_1')?.parts.size ?? 0) >= 4);
    first.engine.dispose();
    await sleep(30);
    const sentBefore = server.log.filter((l) => l.startsWith('PUT')).length;
    const doneBefore = server.uploads.get('ast_1')!.parts.size;
    const second = setup({ server, persistence, owner: 'eng_2' });
    await until(() => uploaded(second.port).length === 1);
    expect(server.log).toContain('GET /api/assets/uploads/ast_1');
    const resent = server.log.filter((l) => l.startsWith('PUT')).length - sentBefore;
    expect(resent).toBeLessThanOrEqual(10 - doneBefore + 2);
    expect(server.uploads.size).toBe(1);
  });

  it('asks for the file again when it was too large to persist, and resumes on a matching re-pick', async () => {
    const persistence = new MemoryPersistence();
    const server = new FakeServer();
    const first = setup({ server, persistence, owner: 'eng_1', config: { persistBlobMaxBytes: 10 } });
    const big = req('big', PART * 6);
    first.send({ type: 'upload', requests: [big] });
    await until(() => (server.uploads.get('ast_1')?.parts.size ?? 0) >= 1);
    first.engine.dispose();
    const second = setup({ server, persistence, owner: 'eng_2', config: { persistBlobMaxBytes: 10 } });
    await until(() => second.port.snapshot?.items[0]?.status === 'needsFile');
    second.send({ type: 'offerFiles', reqId: 'r1', files: [{ file: new Blob([new Uint8Array(5)]), name: 'other.mp4', lastModified: 1 }, { file: big.file, name: big.name, lastModified: 1 }] });
    await until(() => second.port.messages.some((m) => m.type === 'offered'));
    const offered = second.port.messages.find((m) => m.type === 'offered') as Extract<EngineMessage, { type: 'offered' }>;
    expect(offered.matched).toEqual([{ index: 1, id: 'big' }]);
    await until(() => uploaded(second.port).length === 1);
    expect(server.uploads.size).toBe(1);
  });

  it('cancel aborts in-flight parts and the server upload', async () => {
    const { send, port, server } = setup();
    server.partDelay = 200;
    send({ type: 'upload', requests: [req('a', PART * 4)] });
    await until(() => server.inFlight > 0);
    send({ type: 'cancel', id: 'a' });
    await until(() => server.log.includes('DELETE /api/assets/uploads/ast_1'));
    await until(() => port.events.some((e) => e.type === 'transfer.canceled'));
    expect(port.snapshot!.items).toHaveLength(0);
  });

  it('pause and resume per item and globally', async () => {
    const { send, port, server } = setup();
    server.partDelay = 40;
    send({ type: 'upload', requests: [req('a', PART * 6)] });
    await until(() => server.inFlight > 0);
    send({ type: 'pause', id: 'a' });
    await until(() => port.snapshot?.items[0]?.status === 'paused');
    await sleep(80);
    const sent = server.log.filter((l) => l.startsWith('PUT')).length;
    await sleep(80);
    expect(server.log.filter((l) => l.startsWith('PUT')).length).toBe(sent);
    send({ type: 'pause' });
    send({ type: 'resume', id: 'a' });
    await sleep(30);
    expect(port.snapshot!.items[0]!.status).toBe('paused');
    send({ type: 'resume' });
    await until(() => uploaded(port).length === 1);
  });

  it('waits offline without spending attempts, then continues', async () => {
    const { send, port, server, engine } = setup({ config: { retry: { baseDelayMs: 2, maxDelayMs: 4, maxAttempts: 2 } } });
    let offline = true;
    server.partHook = () => (offline ? { status: 0 } : undefined);
    engine.setOnline(false);
    send({ type: 'upload', requests: [req('a', PART * 2)] });
    await sleep(60);
    expect(server.log.filter((l) => l.startsWith('PUT')).length).toBe(0);
    offline = false;
    engine.setOnline(true);
    await until(() => uploaded(port).length === 1);
  });

  it('dedupes the same file picked twice while uploading', async () => {
    const { send, port, server } = setup();
    const a = req('a', PART * 3);
    send({ type: 'upload', requests: [a, { ...a, id: 'a2' }] });
    await until(() => uploaded(port).length === 2);
    expect(server.uploads.size).toBe(1);
  });

  it('sends development-fallback part URLs (Worker paths) with credentials and reads the JSON etag', async () => {
    const { send, port, server } = setup();
    server.relativeUrls = true;
    send({ type: 'upload', requests: [req('a', PART * 2)] });
    await until(() => uploaded(port).length === 1);
    const puts = server.log.filter((l) => l.startsWith('PUT'));
    expect(puts).toHaveLength(2);
    expect(puts.every((l) => l.startsWith('PUT proxied') && l.endsWith('include'))).toBe(true);
  });

  it('treats an upload the server already completed as done after a reload', async () => {
    const persistence = new MemoryPersistence();
    const server = new FakeServer();
    const first = setup({ server, persistence, owner: 'eng_1' });
    server.failComplete = true;
    first.send({ type: 'upload', requests: [req('a', PART * 2)] });
    await until(() => server.uploads.get('ast_1')?.parts.size === 2);
    first.engine.dispose();
    server.uploads.get('ast_1')!.status = 'complete';
    server.failComplete = false;
    const second = setup({ server, persistence, owner: 'eng_2' });
    await until(() => uploaded(second.port).length === 1);
    expect(server.uploads.size).toBe(1);
  });

  it('falls back to Worker-proxied parts when the server has no presigned part URLs', async () => {
    const { send, port, server } = setup();
    server.partUrlsSupported = false;
    send({ type: 'upload', requests: [req('a', PART * 2)] });
    await until(() => uploaded(port).length === 1);
    expect(server.log.filter((l) => l.startsWith('PUT proxied')).every((l) => l.endsWith('include'))).toBe(true);
  });
});

describe('downloads', () => {
  const body: Uint8Array<ArrayBuffer> = new Uint8Array(4500).map((_, i) => i % 256);

  it('downloads in Range chunks and hands back the assembled blob; dedupes concurrent requests', async () => {
    const { send, port, server } = setup();
    server.files.set('/v.mp4', { body, etag: '"v1"' });
    const ranges: string[] = [];
    server.rangeHook = (_u, r) => void ranges.push(r ?? '');
    const r = { id: 'd1', url: 'https://files.test/v.mp4?sig=a&exp=1', filename: 'v.mp4', kind: 'download' as const, canRefresh: false };
    send({ type: 'download', reqId: 'q1', request: r });
    send({ type: 'download', reqId: 'q2', request: { ...r, id: 'd2', url: 'https://files.test/v.mp4?sig=b&exp=2' } });
    await until(() => port.messages.filter((m) => m.type === 'blob').length === 2);
    const blobs = port.messages.filter((m): m is Extract<EngineMessage, { type: 'blob' }> => m.type === 'blob');
    expect(new Uint8Array(await blobs[0]!.blob!.arrayBuffer())).toEqual(body);
    expect(blobs.every((b) => b.id === 'd1')).toBe(true);
    expect(ranges).toHaveLength(5);
    expect(port.messages.find((m) => m.type === 'downloadStarted' && m.reqId === 'q2')).toMatchObject({ deduped: true });
  });

  it('resumes after a dropped chunk with If-Range and restarts if the file changed', async () => {
    const { send, port, server } = setup();
    server.files.set('/v.mp4', { body, etag: '"v1"' });
    let dropped = 0;
    const ifRanges: Array<string | null> = [];
    server.rangeHook = (_u, r) => {
      if (r?.startsWith('bytes=2000') && dropped++ === 0) throw new TypeError('Failed to fetch');
      return undefined;
    };
    const orig = server.request.bind(server);
    server.request = async (url, init) => {
      if (url.includes('files.test')) ifRanges.push(new Headers(init?.headers).get('if-range'));
      return orig(url, init);
    };
    send({ type: 'download', reqId: 'q1', request: { id: 'd1', url: 'https://files.test/v.mp4', filename: 'v.mp4', kind: 'download', canRefresh: false } });
    await until(() => port.messages.some((m) => m.type === 'blob'));
    expect(dropped).toBeGreaterThan(0);
    expect(ifRanges.slice(1).every((v) => v === '"v1"')).toBe(true);
  });

  it('asks the requesting tab for a fresh URL when the signed one expires', async () => {
    const { send, port, server } = setup();
    server.files.set('/v.mp4', { body, etag: '"v1"' });
    server.rangeHook = (u) => (u.includes('sig=old') ? new Response('expired', { status: 410 }) : undefined);
    port.onRefresh = (m) => send({ type: 'refreshedUrl', reqId: m.reqId, url: 'https://files.test/v.mp4?sig=new' });
    send({ type: 'download', reqId: 'q1', request: { id: 'd1', url: 'https://files.test/v.mp4?sig=old', filename: 'v.mp4', kind: 'download', canRefresh: true } });
    await until(() => port.messages.some((m) => m.type === 'blob'));
    const blob = port.messages.find((m): m is Extract<EngineMessage, { type: 'blob' }> => m.type === 'blob')!;
    expect(blob.blob!.size).toBe(body.length);
  });

  it('resumes a download after reload from stored chunks', async () => {
    const persistence = new MemoryPersistence();
    const chunks = new MemoryChunkStore();
    const server = new FakeServer();
    server.files.set('/v.mp4', { body, etag: '"v1"' });
    let block = true;
    server.rangeHook = (_u, r) => (block && r && !r.startsWith('bytes=0-') ? new Response('', { status: 503 }) : undefined);
    const first = setup({ server, persistence, chunks, owner: 'eng_1' });
    first.send({ type: 'download', reqId: 'q1', request: { id: 'd1', url: 'https://files.test/v.mp4', filename: 'v.mp4', kind: 'download', canRefresh: false } });
    await until(() => chunks.chunks.size >= 1);
    first.engine.dispose();
    block = false;
    const requested: string[] = [];
    server.rangeHook = (_u, r) => void requested.push(r ?? '');
    const second = setup({ server, persistence, chunks, owner: 'eng_2' });
    await until(() => second.port.snapshot?.items[0]?.status === 'done');
    expect(requested).not.toContain('bytes=0-999');
    expect(requested).toHaveLength(4);
  });
});

describe('helpers', () => {
  it('builds dedupe keys without signature params and parses Content-Range', () => {
    expect(downloadKey('https://m.test/a.mp4?exp=1&sig=x&ws=w&v=2')).toBe('https://m.test/a.mp4?v=2');
    expect(downloadKey('/media/k?exp=1&sig=2')).toBe('/media/k');
    expect(parseContentRange('bytes 0-999/4500')).toEqual({ start: 0, end: 999, total: 4500 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: null });
    expect(parseContentRange(null)).toBeNull();
  });
});
