/**
 * Transfer manager (D-011) flows. SharedWorker requests are not visible to
 * Playwright's route interception, so each test runs a small Node mock of the
 * upload contract (API origin) and a fake R2 origin for presigned part PUTs,
 * both cross-origin with CORS like production. The app points at them through
 * `window.__ROLLING_TRANSFERS__` (set by an init script).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const MiB = 1024 * 1024;
const PART = 8 * MiB;

interface Upload {
  assetId: string;
  fingerprint?: string;
  name: string;
  size: number;
  partCount: number;
  parts: Map<number, string>;
  status: 'uploading' | 'processing';
}

class MockBackend {
  api!: Server;
  r2!: Server;
  apiUrl = '';
  r2Url = '';
  uploads = new Map<string, Upload>();
  log: string[] = [];
  partDelayMs = 0;
  /** Part numbers whose next PUT loses its connection. */
  dropParts = new Set<number>();
  /** Next N part PUTs answer 429 with Retry-After. */
  throttle = 0;
  inFlight = 0;
  maxInFlight = 0;
  filesInFlight = new Map<string, number>();
  maxFiles = 0;
  files = new Map<string, { body: Buffer; etag: string }>();
  /** Chunk start offsets whose next GET drops mid-body. */
  dropRanges = new Set<number>();
  rangeLog: Array<{ range: string | null; ifRange: string | null }> = [];
  bytesServed = 0;
  private seq = 0;

  async start() {
    this.api = createServer((req, res) => void this.handleApi(req, res));
    this.r2 = createServer((req, res) => void this.handleR2(req, res));
    await Promise.all([new Promise<void>((r) => this.api.listen(0, '127.0.0.1', r)), new Promise<void>((r) => this.r2.listen(0, '127.0.0.1', r))]);
    this.apiUrl = `http://127.0.0.1:${(this.api.address() as AddressInfo).port}`;
    this.r2Url = `http://127.0.0.1:${(this.r2.address() as AddressInfo).port}`;
  }

  async stop() {
    this.api.closeAllConnections();
    this.r2.closeAllConnections();
    await Promise.all([new Promise((r) => this.api.close(r)), new Promise((r) => this.r2.close(r))]);
  }

  private cors(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,range,if-range');
    res.setHeader('access-control-expose-headers', 'ETag,Content-Range,Retry-After,Content-Length');
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private view(up: Upload) {
    return {
      assetId: up.assetId,
      key: `ws/w/uploads/${up.assetId}/${up.name}`,
      uploadId: `u-${up.assetId}`,
      status: up.status,
      partSize: PART,
      partCount: up.partCount,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      parts: [...up.parts].map(([n, etag]) => ({ n, etag, size: PART })),
    };
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse) {
    this.cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url ?? '/', this.apiUrl);
    const path = url.pathname;
    if (!path.startsWith('/files/')) this.log.push(`${req.method} ${path}`);
    let m: RegExpExecArray | null;
    if (req.method === 'POST' && path === '/api/assets/uploads') {
      const b = JSON.parse((await this.body(req)).toString());
      let up = [...this.uploads.values()].find((u) => u.fingerprint === b.fingerprint && u.status === 'uploading');
      if (!up) {
        const assetId = `ast_${++this.seq}`;
        up = { assetId, fingerprint: b.fingerprint, name: b.filename, size: b.size, partCount: Math.max(1, Math.ceil(b.size / PART)), parts: new Map(), status: 'uploading' };
        this.uploads.set(assetId, up);
      }
      return this.json(res, 201, this.view(up));
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)\/part-urls$/.exec(path)) && req.method === 'POST') {
      const b = JSON.parse((await this.body(req)).toString());
      const exp = new Date(Date.now() + 3600_000).toISOString();
      return this.json(res, 200, { urls: (b.partNumbers as number[]).map((n) => ({ n, url: `${this.r2Url}/bucket/${m![1]}/${n}?X-Amz-Signature=x`, expiresAt: exp })) });
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)\/complete$/.exec(path)) && req.method === 'POST') {
      await this.body(req);
      const up = this.uploads.get(m[1]!);
      if (!up || up.parts.size !== up.partCount) return this.json(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'missing parts' } });
      up.status = 'processing';
      return this.json(res, 200, { asset: { id: up.assetId, name: up.name, status: 'processing', size: up.size } });
    }
    if ((m = /^\/api\/assets\/uploads\/([^/]+)$/.exec(path))) {
      const up = this.uploads.get(m[1]!);
      if (!up) return this.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Upload not found' } });
      if (req.method === 'DELETE') {
        this.uploads.delete(up.assetId);
        return this.json(res, 200, { ok: true });
      }
      return this.json(res, 200, this.view(up));
    }
    if (path.startsWith('/files/') && req.method === 'GET') return this.serveFile(req, res, path);
    return this.json(res, 404, { error: { code: 'NOT_FOUND' } });
  }

  private async serveFile(req: IncomingMessage, res: ServerResponse, path: string) {
    const f = this.files.get(path.slice('/files/'.length));
    if (!f) return this.json(res, 404, {});
    const range = req.headers.range ?? null;
    const ifRange = (req.headers['if-range'] as string | undefined) ?? null;
    this.rangeLog.push({ range, ifRange });
    const m = range ? /bytes=(\d+)-(\d+)?/.exec(range) : null;
    if (!m || (ifRange && ifRange !== f.etag)) {
      this.bytesServed += f.body.length;
      res.writeHead(200, { etag: f.etag, 'content-length': f.body.length, 'content-type': 'application/octet-stream' });
      return res.end(f.body);
    }
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : f.body.length - 1, f.body.length - 1);
    const slice = f.body.subarray(start, end + 1);
    res.writeHead(206, { etag: f.etag, 'content-range': `bytes ${start}-${end}/${f.body.length}`, 'content-length': slice.length, 'content-type': 'application/octet-stream' });
    if (this.dropRanges.delete(start)) {
      res.write(slice.subarray(0, slice.length >> 1));
      this.bytesServed += slice.length >> 1;
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    this.bytesServed += slice.length;
    res.end(slice);
  }

  private async handleR2(req: IncomingMessage, res: ServerResponse) {
    this.cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const m = /^\/bucket\/([^/]+)\/(\d+)/.exec(req.url ?? '');
    if (!m || req.method !== 'PUT') return res.writeHead(404).end();
    const [, assetId, nStr] = m;
    const n = Number(nStr);
    this.log.push(`PUT part ${n} cookie=${req.headers.cookie ? 'yes' : 'no'}`);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.filesInFlight.set(assetId!, (this.filesInFlight.get(assetId!) ?? 0) + 1);
    this.maxFiles = Math.max(this.maxFiles, [...this.filesInFlight.values()].filter((v) => v > 0).length);
    const done = () => {
      this.inFlight -= 1;
      this.filesInFlight.set(assetId!, this.filesInFlight.get(assetId!)! - 1);
    };
    try {
      const body = await this.body(req);
      if (this.partDelayMs) await new Promise((r) => setTimeout(r, this.partDelayMs));
      if (this.dropParts.delete(n)) {
        // Break the response after the headers (a reset before any response would be retried by the browser itself).
        done();
        res.writeHead(200, { 'content-length': '64' });
        res.write('x');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (this.throttle > 0) {
        this.throttle -= 1;
        done();
        res.writeHead(429, { 'retry-after': '1' });
        return res.end();
      }
      const up = this.uploads.get(assetId!);
      if (!up) {
        done();
        return res.writeHead(404).end();
      }
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      up.parts.set(n, etag);
      done();
      res.writeHead(200, { etag });
      res.end();
    } catch {
      done();
    }
  }

  puts(n?: number) {
    return this.log.filter((l) => l.startsWith('PUT part') && (n === undefined || l.startsWith(`PUT part ${n} `))).length;
  }
}

let backend: MockBackend;
const FIXTURES = join(tmpdir(), `rolling-transfers-${process.pid}`);

test.beforeEach(async ({ context }) => {
  backend = new MockBackend();
  await backend.start();
  await useBackend(context, backend);
});

test.afterEach(async () => {
  await backend.stop();
});

async function useBackend(context: BrowserContext, b: MockBackend, extra: Record<string, unknown> = {}) {
  await context.addInitScript(
    ({ apiBase, extra }) => {
      (window as unknown as { __ROLLING_TRANSFERS__: unknown }).__ROLLING_TRANSFERS__ = {
        expose: true,
        config: { apiBase, api: 'real', retry: { baseDelayMs: 200, maxDelayMs: 1000, maxAttempts: 8 }, ...extra },
      };
    },
    { apiBase: b.apiUrl, extra },
  );
}

/** A file on disk (stable lastModified, so re-picking it matches the fingerprint). */
function fixture(name: string, size: number): string {
  mkdirSync(FIXTURES, { recursive: true });
  const p = join(FIXTURES, name);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buf[i] = (i / 4096) % 251;
  writeFileSync(p, buf);
  return p;
}

/** Queue in-page files through the client API; returns the item ids. */
async function uploadInPage(page: Page, files: Array<{ name: string; size: number; type?: string }>, opts: Record<string, unknown> = {}) {
  return page.evaluate(
    ({ files, opts }) => {
      const t = (window as unknown as { __rollingTransfers: { uploadFiles: (f: File[], o: unknown) => { items: Array<{ id: string }> } } }).__rollingTransfers;
      const list = files.map((f) => new File([new Uint8Array(f.size)], f.name, { type: f.type ?? 'video/mp4', lastModified: 1_700_000_000_000 }));
      return t.uploadFiles(list, { purpose: 'library', ...opts }).items.map((i) => i.id);
    },
    { files, opts },
  );
}

async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { __rollingTransfers: { getSnapshot: () => { items: Array<Record<string, unknown>>; uploadCap: number; mode: string; partsInFlight: number } } }).__rollingTransfers.getSnapshot());
}

async function openDock(page: Page) {
  const dock = page.getByTestId('transfers-dock');
  await expect(dock).toBeVisible();
  const panel = page.getByRole('dialog', { name: 'Transfers' });
  if (!(await panel.isVisible())) await dock.getByRole('button', { name: /^Transfers:/ }).click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Goes to a page and waits until the app (and the dock's listeners) mounted. */
async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('app-header')).toBeVisible();
}

async function uploadFromAssets(page: Page, path: string) {
  await open(page, '/assets');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload' }).click();
  await (await chooser).setFiles(path);
}

test.describe('transfers (D-011)', () => {
  test('two tabs share one queue: progress and controls appear in both', async ({ context, page }) => {
    await useBackend(context, backend, { concurrency: { partsPerUpload: 1 } });
    backend.partDelayMs = 1500;
    await uploadFromAssets(page, fixture('shared.mp4', 40 * MiB));
    const other = await context.newPage();
    await open(other);
    const panel = await openDock(other);
    await expect(panel.locator('[data-transfer="shared.mp4"]')).toBeVisible();
    expect(await snapshot(other)).toMatchObject({ mode: 'shared' });
    // Pause from the second tab; the first tab sees it.
    await panel.getByRole('button', { name: 'Pause shared.mp4' }).click();
    await expect(page.locator('[data-testid="transfers-dock"]')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).items[0]?.status).toBe('paused');
    await openDock(page).then((p) => p.getByRole('button', { name: 'Resume shared.mp4' }).click());
    await expect(page.getByText('shared.mp4 uploaded.')).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await snapshot(other)).items[0]?.status).toBe('done');
    expect(backend.log.filter((l) => l.startsWith('PUT part')).every((l) => l.endsWith('cookie=no'))).toBe(true);
  });

  test('uploads several files concurrently under the global cap; the dock counts uploading and queued', async ({ page }) => {
    backend.partDelayMs = 900;
    await open(page);
    await uploadInPage(page, Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.mp4`, size: 9 * MiB })));
    const panel = await openDock(page);
    await expect(panel.getByTestId('transfers-summary')).toHaveText('4 uploading · 2 queued', { timeout: 10_000 });
    await expect.poll(() => backend.maxFiles, { timeout: 10_000 }).toBe(4);
    expect(backend.maxInFlight).toBeLessThanOrEqual(8);
    await expect.poll(async () => (await snapshot(page)).items.filter((i) => i.status === 'done').length, { timeout: 30_000 }).toBe(6);
    expect(backend.maxInFlight).toBeGreaterThanOrEqual(4);
    expect(backend.maxInFlight).toBeLessThanOrEqual(16);
  });

  test('AIMD: 429s halve the global cap and Retry-After is honoured', async ({ page }) => {
    backend.partDelayMs = 300;
    await open(page);
    await uploadInPage(page, [{ name: 'a.mp4', size: 40 * MiB }, { name: 'b.mp4', size: 40 * MiB }]);
    await expect.poll(() => backend.puts()).toBeGreaterThan(2);
    backend.throttle = 3;
    await expect.poll(async () => (await snapshot(page)).uploadCap).toBeLessThanOrEqual(4);
    await expect.poll(async () => (await snapshot(page)).items.filter((i) => i.status === 'done').length, { timeout: 30_000 }).toBe(2);
  });

  test('a dropped connection mid-upload retries the part and finishes; offline pauses the queue', async ({ context, page }) => {
    await useBackend(context, backend, { retry: { baseDelayMs: 4000, maxDelayMs: 8000, maxAttempts: 8 } });
    backend.partDelayMs = 300;
    backend.dropParts.add(2);
    await open(page);
    await uploadInPage(page, [{ name: 'drop.mp4', size: 24 * MiB }]);
    await expect.poll(async () => (await snapshot(page)).items[0]?.status, { timeout: 10_000 }).toBe('retrying');
    const panel = await openDock(page);
    await expect(panel.locator('[data-transfer="drop.mp4"]')).toContainText(/retrying/);
    await context.setOffline(true);
    await expect(panel).toContainText('You’re offline');
    const sent = backend.puts();
    await page.waitForTimeout(1500);
    expect(backend.puts()).toBe(sent);
    await context.setOffline(false);
    await expect.poll(async () => (await snapshot(page)).items[0]?.status, { timeout: 20_000 }).toBe('done');
    expect(backend.puts(2)).toBe(2);
    expect(backend.uploads.get('ast_1')!.status).toBe('processing');
  });

  test('reload mid-upload resumes from the stored file and server-reported parts', async ({ context, page }) => {
    await useBackend(context, backend, { concurrency: { partsPerUpload: 1 } });
    backend.partDelayMs = 1000;
    await open(page);
    await uploadInPage(page, [{ name: 'reload.mp4', size: 40 * MiB }]);
    await expect.poll(() => backend.uploads.get('ast_1')?.parts.size ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(backend.uploads.get('ast_1')!.parts.size).toBeLessThan(5);
    await page.reload();
    await expect.poll(async () => (await snapshot(page)).items[0]?.status, { timeout: 30_000 }).toBe('done');
    expect(backend.uploads.size).toBe(1);
    // At most the parts that were in flight at reload are sent twice.
    expect(backend.puts()).toBeLessThanOrEqual(5 + 1);
  });

  test('cancel aborts the server upload', async ({ page }) => {
    backend.partDelayMs = 1500;
    await open(page);
    await uploadInPage(page, [{ name: 'cancel.mp4', size: 24 * MiB }]);
    const panel = await openDock(page);
    await expect.poll(() => backend.inFlight).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Cancel cancel.mp4' }).click();
    await expect.poll(() => backend.log).toContain('DELETE /api/assets/uploads/ast_1');
    await expect(panel.locator('[data-transfer="cancel.mp4"]')).toHaveCount(0);
  });

  test('files over the limits are refused before any request', async ({ page }) => {
    await open(page);
    const ids = await uploadInPage(page, [{ name: 'huge.png', size: 31 * MiB, type: 'image/png' }]);
    expect(ids).toEqual([]);
    await expect(page.getByText(/huge\.png is too large/)).toBeVisible();
    expect(backend.log).toEqual([]);
  });

  test('downloads resume with Range/If-Range after a drop, and tabs share one download', async ({ context, page }) => {
    const body = Buffer.alloc(20 * MiB);
    for (let i = 0; i < body.length; i += 997) body[i] = i % 256;
    backend.files.set('big.bin', { body, etag: '"big-v1"' });
    backend.dropRanges.add(8 * MiB);
    const other = await context.newPage();
    await Promise.all([open(page), open(other)]);
    const url = (sig: string) => `${backend.apiUrl}/files/big.bin?sig=${sig}&exp=9999999999`;
    const run = (p: Page, sig: string) =>
      p.evaluate(
        async ({ u }) => {
          const t = (window as unknown as { __rollingTransfers: { fetchBlob: (u: string) => Promise<Blob> } }).__rollingTransfers;
          const blob = await t.fetchBlob(u);
          const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
          return { size: blob.size, hash: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') };
        },
        { u: url(sig) },
      );
    const [a, b] = await Promise.all([run(page, 'one'), run(other, 'two')]);
    const expected = createHash('sha256').update(body).digest('hex');
    expect(a).toEqual({ size: body.length, hash: expected });
    expect(b).toEqual(a);
    // One download for both tabs: 3 chunks plus the retried one.
    expect(backend.rangeLog.length).toBe(4);
    expect(backend.rangeLog.filter((r) => r.range === `bytes=${8 * MiB}-${16 * MiB - 1}`)).toHaveLength(2);
    expect(backend.rangeLog.slice(1).every((r) => r.ifRange === '"big-v1"')).toBe(true);
    expect(backend.bytesServed).toBeLessThan(body.length + 8 * MiB);
  });

  test('download() hands the assembled file to the tab to save', async ({ page }) => {
    const body = Buffer.from('hello transfers '.repeat(1000));
    backend.files.set('notes.bin', { body, etag: '"n1"' });
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await open(page);
    const dl = page.waitForEvent('download');
    await page.evaluate((u) => {
      const t = (window as unknown as { __rollingTransfers: { download: (u: string, o: unknown) => Promise<unknown> } }).__rollingTransfers;
      void t.download(u, { filename: 'notes.bin' });
    }, `${backend.apiUrl}/files/notes.bin`);
    const d = await dl;
    expect(d.suggestedFilename()).toBe('notes.bin');
    await expect(page.getByText('notes.bin downloaded.')).toBeVisible();
  });

  test('fallback without SharedWorker: dedicated worker, reload asks to pick a large file again and resumes', async ({ context, page }) => {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'SharedWorker', { value: undefined, configurable: true });
    });
    // Treat everything as "too large to keep" so the re-pick path runs with a small fixture.
    await useBackend(context, backend, { persistBlobMaxBytes: 1024, concurrency: { partsPerUpload: 1 } });
    backend.partDelayMs = 1000;
    const path = fixture('big-take.mp4', 40 * MiB);
    await uploadFromAssets(page, path);
    await expect.poll(async () => (await snapshot(page)).mode).toBe('dedicated');
    await expect.poll(() => backend.uploads.get('ast_1')?.parts.size ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(backend.uploads.get('ast_1')!.parts.size).toBeLessThan(5);
    await page.reload();
    const panel = await openDock(page);
    const row = panel.locator('[data-transfer="big-take.mp4"]');
    await expect(row).toContainText('Pick big-take.mp4 again to resume');
    const chooser = page.waitForEvent('filechooser');
    await row.getByRole('button', { name: 'Pick big-take.mp4 again' }).click();
    await (await chooser).setFiles(path);
    await expect(page.getByText('Upload resumed.')).toBeVisible();
    await expect.poll(async () => (await snapshot(page)).items[0]?.status, { timeout: 20_000 }).toBe('done');
    expect(backend.uploads.size).toBe(1);
    expect(backend.log).toContain('GET /api/assets/uploads/ast_1');
  });

  test('last resort without workers: the engine runs on the main thread', async ({ context, page }) => {
    await context.addInitScript(() => {
      (window as unknown as { __ROLLING_TRANSFERS__: { mode?: string } }).__ROLLING_TRANSFERS__.mode = 'main';
    });
    await open(page);
    await uploadInPage(page, [{ name: 'main.mp4', size: 9 * MiB }]);
    await expect.poll(async () => (await snapshot(page)).items[0]?.status, { timeout: 10_000 }).toBe('done');
    expect((await snapshot(page)).mode).toBe('main');
    expect(backend.uploads.get('ast_1')!.status).toBe('processing');
  });

  test('dock: keyboard opens the panel, reduced motion fades only', async ({ page }) => {
    backend.partDelayMs = 2000;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await uploadInPage(page, [{ name: 'motion.mp4', size: 9 * MiB }]);
    const trigger = page.getByTestId('transfers-dock').getByRole('button', { name: /^Transfers:/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Transfers' });
    await expect(panel).toBeVisible();
    // Movement tokens collapse under reduced motion, so the pop-in is a plain fade.
    const dock = page.getByTestId('transfers-dock');
    await expect(dock).toHaveAttribute('data-motion', '');
    expect(await dock.evaluate((el) => getComputedStyle(el).getPropertyValue('--m-move-popover').trim())).toBe('0px');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});
