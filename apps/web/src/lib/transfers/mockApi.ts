/**
 * Dev mock of the resumable upload contract (D-011) for local work without
 * the API Worker: the same endpoints, presigned "R2" part URLs and timing
 * (latency plus a simulated link speed) so progress, pause and resume behave
 * like production. Used only when `api` resolves to 'mock' (localhost with no
 * API answering `/api/health`, or forced). Downloads always use the network.
 */
import { checkUpload, UPLOAD_PART_SIZE } from '@rolling/core/media/limits';
import { AbortError, type Http, type PutResult } from './http';

interface MockUpload {
  assetId: string;
  fingerprint?: string;
  name: string;
  contentType: string;
  kind: string;
  size: number;
  partCount: number;
  parts: Map<number, { etag: string; size: number }>;
  status: 'uploading' | 'complete';
  expiresAt: number;
}

export interface MockOptions {
  latencyMs?: number;
  /** Simulated upload speed per part, bytes per second. */
  bytesPerSecond?: number;
  /** Fallback for anything that is not an upload endpoint. */
  passthrough: Http;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new AbortError());
    });
  });

let seq = 0;
const newAssetId = () => `ast_mock${Date.now().toString(36)}${(seq++).toString(36)}`;

export function createMockHttp(opts: MockOptions): Http & { uploads: Map<string, MockUpload> } {
  const latency = opts.latencyMs ?? 120;
  const speed = opts.bytesPerSecond ?? 25 * 1024 * 1024;
  const uploads = new Map<string, MockUpload>();

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url, 'http://mock.invalid');
    const m = /^\/api\/assets\/uploads(?:\/([^/]+)(?:\/(part-urls|complete))?)?$/.exec(u.pathname);
    if (!m) return opts.passthrough.request(url, init);
    await sleep(latency);
    const method = (init.method ?? 'GET').toUpperCase();
    const [, id, action] = m;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (!id && method === 'POST') {
      const size = Number(body.size);
      const check = checkUpload(String(body.contentType ?? ''), size);
      if (!check.ok) return json(check.reason === 'TOO_LARGE' ? 413 : 415, { error: { code: 'VALIDATION_FAILED', message: check.reason, data: { reason: check.reason } } });
      const fp = typeof body.fingerprint === 'string' ? body.fingerprint : undefined;
      let up = fp ? [...uploads.values()].find((x) => x.fingerprint === fp && x.status === 'uploading' && x.expiresAt > Date.now()) : undefined;
      if (!up) {
        up = {
          assetId: newAssetId(),
          fingerprint: fp,
          name: String(body.filename ?? 'file'),
          contentType: String(body.contentType),
          kind: check.kind,
          size,
          partCount: check.parts,
          parts: new Map(),
          status: 'uploading',
          expiresAt: Date.now() + 7 * 24 * 3600_000,
        };
        uploads.set(up.assetId, up);
      }
      return json(201, view(up));
    }
    const up = id ? uploads.get(decodeURIComponent(id)) : undefined;
    if (!up) return json(404, { error: { code: 'NOT_FOUND', message: 'Upload not found' } });
    if (!action && method === 'GET') return json(200, view(up));
    if (!action && method === 'DELETE') {
      uploads.delete(up.assetId);
      return json(200, { ok: true });
    }
    if (action === 'part-urls' && method === 'POST') {
      const exp = Date.now() + 3600_000;
      const nums = Array.isArray(body.partNumbers) ? (body.partNumbers as number[]) : [];
      return json(200, { assetId: up.assetId, direct: true, urls: nums.map((n) => ({ n, url: `https://mock-r2.invalid/${up.assetId}/${n}?exp=${exp}`, expiresAt: new Date(exp).toISOString() })) });
    }
    if (action === 'complete' && method === 'POST') {
      if (up.parts.size !== up.partCount) return json(400, { error: { code: 'VALIDATION_FAILED', message: 'Every part must be uploaded once' } });
      up.status = 'complete';
      return json(200, {
        asset: {
          id: up.assetId,
          kind: up.kind,
          source: 'mine',
          name: up.name,
          status: 'processing',
          mature: false,
          size: up.size,
          contentType: up.contentType,
          createdAt: new Date().toISOString(),
          url: null,
          thumbUrl: null,
          meta: { processing: 'queued' },
        },
      });
    }
    return json(405, { error: { code: 'BAD_REQUEST', message: 'Unsupported' } });
  }

  async function put(url: string, blob: Blob, o: Parameters<Http['put']>[2]): Promise<PutResult> {
    const m = /^https:\/\/mock-r2\.invalid\/([^/]+)\/(\d+)/.exec(url);
    if (!m) return opts.passthrough.put(url, blob, o);
    const up = uploads.get(m[1]!);
    if (!up) return { status: 404, header: () => null, text: '' };
    await sleep(latency, o.signal);
    const total = blob.size;
    const ms = Math.max(150, (total / speed) * 1000);
    const steps = Math.max(2, Math.round(ms / 80));
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps, o.signal);
      o.onProgress?.(Math.round((total * i) / steps));
    }
    const etag = `"${m[1]}-${m[2]}-${total}"`;
    up.parts.set(Number(m[2]), { etag, size: total });
    return { status: 200, header: (n) => (n.toLowerCase() === 'etag' ? etag : null), text: '' };
  }

  return { request, put, uploads };
}

function view(up: MockUpload) {
  return {
    assetId: up.assetId,
    key: `ws/mock/uploads/${up.assetId}/${up.name}`,
    uploadId: `mock-${up.assetId}`,
    status: up.status,
    partSize: UPLOAD_PART_SIZE,
    partCount: up.partCount,
    expiresAt: new Date(up.expiresAt).toISOString(),
    parts: [...up.parts.entries()].map(([n, p]) => ({ n, size: p.size, etag: p.etag })),
  };
}
