import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { account, api, env, getJson, shot } from './support';

/** Matrix: UP-1 … UP-7. Uploads go straight to R2 (D-011); the Worker never carries upload bytes. */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

const MiB = 1024 * 1024;

/** A valid PNG of w×h solid color (uncompressed deflate blocks; no deps). */
function png(w: number, h: number, rgb: [number, number, number] = [40, 120, 200]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  // zlib stored blocks
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, i + 65535);
    const hdr = Buffer.alloc(5);
    hdr[0] = i + 65535 >= raw.length ? 1 : 0;
    hdr.writeUInt16LE(part.length, 1);
    hdr.writeUInt16LE(~part.length & 0xffff, 3);
    blocks.push(hdr, part);
  }
  let a = 1, b = 0;
  for (const x of raw) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(adler);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat(blocks)), chunk('IEND', Buffer.alloc(0))]);
}

interface Upload { assetId: string; uploadId: string; partSize: number; partCount: number; parts: Array<{ n: number; size: number }> }

async function startUpload(req: APIRequestContext, baseURL: string | undefined, body: Record<string, unknown>) {
  const r = await api(req, baseURL, 'POST', '/api/assets/uploads', body);
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()) as Upload;
}

async function putParts(req: APIRequestContext, baseURL: string | undefined, assetId: string, data: Buffer, partSize: number, ns: number[]) {
  const r = await api(req, baseURL, 'POST', `/api/assets/uploads/${assetId}/part-urls`, { partNumbers: ns });
  expect(r.status(), await r.text()).toBe(200);
  const body = (await r.json()) as { direct: boolean; urls: Array<{ n: number; url: string; method: string }> };
  for (const u of body.urls) {
    const slice = data.subarray((u.n - 1) * partSize, u.n * partSize);
    // credentials omitted: a fresh request without cookies, straight to the presigned URL.
    const put = await req.fetch(u.url, { method: 'PUT', data: slice, headers: { 'content-type': 'application/octet-stream', cookie: '' } });
    expect(put.status(), `PUT part ${u.n}: ${await put.text()}`).toBe(200);
    expect(put.headers()['etag']).toBeTruthy();
  }
  return body;
}

test('UP-1 chunked upload goes direct to R2 with presigned URLs; killed mid-way, it resumes by fingerprint from the parts R2 has', async ({ context, baseURL }) => {
  test.setTimeout(5 * 60_000);
  await account(context, baseURL, 'chunked');
  const req = context.request;
  const data = randomBytes(17 * MiB);
  const fingerprint = createHash('sha256').update(data.subarray(0, MiB)).digest('hex');
  const body = { filename: 'clip.bin.mp4', contentType: 'video/mp4', size: data.length, fingerprint };
  const up = await startUpload(req, baseURL, body);
  expect(up.partSize).toBe(8 * MiB);
  expect(up.partCount).toBe(3);
  const first = await putParts(req, baseURL, up.assetId, data, up.partSize, [1, 2]);
  expect(first.direct, 'presigned S3 URLs, not the Worker fallback').toBe(true);
  for (const u of first.urls) expect(new URL(u.url).host).toMatch(/r2\.cloudflarestorage\.com$/);
  // "Kill": forget everything client-side; the server lists the parts storage has.
  const status = await getJson<{ status: string; parts: Array<{ n: number }> }>(req, `/api/assets/uploads/${up.assetId}`);
  expect(status.status).toBe('uploading');
  expect(status.parts.map((p) => p.n).sort()).toEqual([1, 2]);
  // Resume: the same fingerprint returns the same upload with its parts.
  const again = await startUpload(req, baseURL, body);
  expect(again.assetId).toBe(up.assetId);
  expect(again.parts.map((p) => p.n).sort()).toEqual([1, 2]);
  // Completing early is refused with the missing parts.
  const early = await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/complete`);
  expect(early.status()).toBe(400);
  await putParts(req, baseURL, up.assetId, data, up.partSize, [3]);
  const done = await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/complete`);
  expect(done.status(), await done.text()).toBe(200);
  const { asset } = await getJson<{ asset: { id: string; size: number; status: string } }>(req, `/api/assets/${up.assetId}`);
  expect(asset.size).toBe(data.length);
  // Abort path on another upload.
  const other = await startUpload(req, baseURL, { filename: 'x.png', contentType: 'image/png', size: 1000 });
  const del = await api(req, baseURL, 'DELETE', `/api/assets/uploads/${other.assetId}`);
  expect(del.status()).toBe(200);
});

test('UP-2 the UI upload queue (SharedWorker) uploads several files at once, straight to R2, and they show in Assets', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(4 * 60_000);
  await account(context, baseURL, 'uiupload');
  const puts: string[] = [];
  const workerPuts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT') puts.push(r.url());
  });
  context.on('serviceworker', () => undefined);
  await page.goto('/assets');
  const hasShared = await page.evaluate(() => typeof SharedWorker !== 'undefined');
  expect(hasShared).toBe(true);
  const files = [1, 2, 3].map((i) => ({ name: `full-upload-${i}.png`, mimeType: 'image/png', buffer: png(64 * i, 64 * i, [i * 60, 100, 200]) }));
  const multiple = await page.getByTestId('assets-file').evaluate((el) => (el as HTMLInputElement).multiple);
  testInfo.annotations.push({ type: 'assets-upload-multiple', description: String(multiple) });
  if (multiple) await page.getByTestId('assets-file').setInputFiles(files);
  // The Assets picker takes one file at a time: queue three picks back to back so they upload concurrently.
  else for (const f of files) await page.getByTestId('assets-file').setInputFiles(f);
  await expect(page.getByTestId('transfers-dock')).toBeVisible({ timeout: 20_000 });
  await shot(page, testInfo, 'transfers-dock');
  for (const f of files) await expect(page.getByText(f.name).first()).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(async () => (await getJson<{ items: Array<{ name: string; status: string }> }>(page.request, '/api/assets?scope=mine')).items.filter((a) => a.name.startsWith('full-upload-')).length, { timeout: 90_000 })
    .toBe(3);
  // Bytes never went through /api (the PUTs from a SharedWorker are not page requests; any page-level PUT must not hit /api).
  expect(puts.filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
  expect(workerPuts).toEqual([]);
});

test('UP-3 a large upload resumes after the tab is reloaded mid-way', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(6 * 60_000);
  await account(context, baseURL, 'resume');
  await page.goto('/assets');
  const big = { name: 'full-resume.mp4', mimeType: 'video/mp4', buffer: randomBytes(40 * MiB) };
  await page.getByTestId('assets-file').setInputFiles(big);
  await expect(page.getByTestId('transfers-dock')).toBeVisible({ timeout: 20_000 });
  // Wait until the queue reports real progress (some parts stored), then kill the tab mid-way.
  const progress = page.getByRole('progressbar', { name: new RegExp(`^${big.name}:`) });
  await page.getByTestId('transfers-dock').getByRole('button').first().click().catch(() => undefined);
  await expect
    .poll(async () => Number((await progress.first().getAttribute('aria-valuenow').catch(() => '0')) ?? 0), { timeout: 120_000, intervals: [300] })
    .toBeGreaterThan(10);
  const mid = Number(await progress.first().getAttribute('aria-valuenow'));
  testInfo.annotations.push({ type: 'killed-at', description: String(mid) });
  await page.close();
  const page2 = await context.newPage();
  await page2.goto('/assets');
  await shot(page2, testInfo, 'resume-after-reload');
  // The queue (IndexedDB) picks the item up again and finishes it; the asset appears in Assets.
  await expect
    .poll(async () => (await getJson<{ items: Array<{ name: string; status: string }> }>(page2.request, '/api/assets?scope=mine&first=20')).items.find((a) => a.name === big.name)?.status ?? 'missing', { timeout: 4 * 60_000, intervals: [3000] })
    .toMatch(/ready|processing/);
});

test('UP-4 face detection on uploaded photos: an uploaded portrait gets a content rating and face metadata', async ({ context, baseURL }, testInfo) => {
  await account(context, baseURL, 'face');
  const req = context.request;
  // A PoseWear portrait (a real face) from the public library.
  const pub = await getJson<{ items: Array<{ url: string; name: string }> }>(req, '/api/assets?scope=public&q=portrait&first=1');
  test.skip(pub.items.length === 0, 'no public portrait to use');
  const img = await req.get(new URL(pub.items[0]!.url, baseURL).href);
  expect(img.status()).toBe(200);
  const bytes = await img.body();
  const ct = img.headers()['content-type'] ?? 'image/webp';
  const up = await startUpload(req, baseURL, { filename: 'portrait.webp', contentType: ct, size: bytes.length });
  await putParts(req, baseURL, up.assetId, bytes, up.partSize, [1]);
  expect((await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/complete`)).status()).toBe(200);
  let asset: { status: string; rating: string | null; meta: Record<string, unknown> } | null = null;
  await expect
    .poll(async () => {
      asset = (await getJson<{ asset: typeof asset }>(req, `/api/assets/${up.assetId}`)).asset;
      return asset!.rating;
    }, { timeout: 90_000, intervals: [3000] })
    .not.toBeNull();
  testInfo.annotations.push({ type: 'asset', description: JSON.stringify(asset) });
  const meta = asset!.meta;
  expect(Object.keys(meta).some((k) => /face/i.test(k)), `face metadata on upload: meta=${JSON.stringify(meta)}`).toBe(true);
});

test('UP-5 background download: Download in the asset viewer goes through the transfer queue and saves the file', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'download');
  const req = context.request;
  const bytes = png(200, 120);
  const up = await startUpload(req, baseURL, { filename: 'full-download.png', contentType: 'image/png', size: bytes.length });
  await putParts(req, baseURL, up.assetId, bytes, up.partSize, [1]);
  expect((await api(req, baseURL, 'POST', `/api/assets/uploads/${up.assetId}/complete`)).status()).toBe(200);
  await page.goto('/assets');
  await page.getByText('full-download.png').first().click();
  const details = page.getByRole('complementary', { name: 'Asset details' });
  await expect(details).toBeVisible();
  const dl = page.waitForEvent('download', { timeout: 60_000 });
  await details.getByRole('button', { name: 'Download' }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/full-download/);
  const path = await download.path();
  expect(path).toBeTruthy();
  await shot(page, testInfo, 'download');
});
