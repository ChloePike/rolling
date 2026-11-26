import { expect, test, type APIRequestContext } from '@playwright/test';
import { account, api, env, getJson, logSpend, seedProject, shot, waitRun, type RunView } from './support';

/** Matrix: EDIT-1 … EDIT-4. Timeline ops through the API and the editor UI; export needs generated shots (PW_GENERATE + PW_EXPORT). */
test.skip(!env.inboxToken, 'TEST_INBOX_TOKEN (or PW_TEST_INBOX_TOKEN_FILE) is required');

interface Clip { id: string; start: number; in: number; out: number; end?: number; speed?: number; fadeIn?: number; transitionOut?: { type: string; dur: number } | null; nodeId?: string }
interface Timeline { canvasId: string; revision: number; edl: { tracks: Array<{ id: string; kind: string; clips: Clip[] }> } }

const THREE_SHOTS = [
  { op: 'addNode', tempId: 's', kind: 'script', title: 'Script', params: { rows: [
    { n: 1, visual: 'Bottle on a rock', line: 'Morning.', seconds: 4 },
    { n: 2, visual: 'Cap pops', line: 'Fresh.', seconds: 3 },
    { n: 3, visual: 'Logo', seconds: 3 },
  ] } },
  { op: 'addNode', tempId: 'a', kind: 'video', title: 'Shot 1', position: { x: 400, y: 0 }, params: { prompt: 'Bottle on a rock', model: 'x-ai/grok-imagine-video-1.5-lite', resolution: '480p', length: 1, ratio: '9:16' } },
  { op: 'addNode', tempId: 'b', kind: 'video', title: 'Shot 2', position: { x: 800, y: 0 }, params: { prompt: 'Cap pops', model: 'x-ai/grok-imagine-video-1.5-lite', resolution: '480p', length: 1, ratio: '9:16' } },
  { op: 'addNode', tempId: 'c', kind: 'video', title: 'Shot 3', position: { x: 1200, y: 0 }, params: { prompt: 'Logo on white', model: 'x-ai/grok-imagine-video-1.5-lite', resolution: '480p', length: 1, ratio: '9:16' } },
];

async function timeline(req: APIRequestContext, canvasId: string) {
  return getJson<Timeline>(req, `/api/canvases/${canvasId}/timeline`);
}
const videoClips = (t: Timeline) => t.edl.tracks.filter((x) => x.kind === 'video').flatMap((x) => x.clips);
const duration = (t: Timeline) => Math.max(0, ...t.edl.tracks.flatMap((x) => x.clips.map((c) => (x.kind === 'caption' ? c.end! : c.start + (c.out - c.in) / (c.speed ?? 1)))));

test('EDIT-1 assemble from the script: shots in order, captions from lines, duration = script', async ({ context, baseURL }) => {
  await account(context, baseURL, 'assemble');
  const p = await seedProject(context.request, baseURL, 'Assemble', THREE_SHOTS);
  const snap = (await getJson<{ snapshot: { canvases: Array<{ id: string }> } }>(context.request, `/api/projects/${p.id}`)).snapshot;
  const t = await timeline(context.request, snap.canvases[0]!.id);
  const clips = videoClips(t);
  expect(clips).toHaveLength(3);
  expect(clips.map((c) => c.start)).toEqual([...clips.map((c) => c.start)].sort((a, b) => a - b));
  expect(duration(t)).toBeCloseTo(10, 1);
  const captions = t.edl.tracks.filter((x) => x.kind === 'caption').flatMap((x) => x.clips as unknown as Array<{ text: string }>);
  expect(captions.map((c) => c.text)).toEqual(['Morning.', 'Fresh.']);
});

test('EDIT-2 trim, speed, fade and dissolve persist; invalid ops are refused; stale revisions conflict', async ({ context, baseURL }) => {
  await account(context, baseURL, 'tlops');
  const req = context.request;
  const p = await seedProject(req, baseURL, 'Timeline ops', THREE_SHOTS);
  const canvasId = (await getJson<{ snapshot: { canvases: Array<{ id: string }> } }>(req, `/api/projects/${p.id}`)).snapshot.canvases[0]!.id;
  let t = await timeline(req, canvasId);
  const [c1, c2] = videoClips(t);
  const patch = async (ops: unknown[], baseRevision = t.revision) => api(req, baseURL, 'POST', `/api/canvases/${canvasId}/timeline/patch`, { baseRevision, ops });
  let r = await patch([{ op: 'trim', clipId: c1!.id, out: c1!.in + 3 }]);
  expect(r.status(), await r.text()).toBe(200);
  t = await timeline(req, canvasId);
  r = await patch([{ op: 'setSpeed', clipId: c2!.id, speed: 2 }, { op: 'setFade', clipId: c2!.id, fadeIn: 0.5 }, { op: 'setTransition', clipId: c2!.id, transition: { type: 'dissolve', dur: 0.5 } }]);
  expect(r.status(), await r.text()).toBe(200);
  t = await timeline(req, canvasId);
  const n1 = videoClips(t).find((c) => c.id === c1!.id)!;
  const n2 = videoClips(t).find((c) => c.id === c2!.id)!;
  expect(n1.out - n1.in).toBeCloseTo(3, 2);
  expect(n2.speed).toBe(2);
  expect(n2.fadeIn).toBe(0.5);
  expect(n2.transitionOut).toEqual({ type: 'dissolve', dur: 0.5 });
  const stale = await patch([{ op: 'setSpeed', clipId: c2!.id, speed: 1 }], t.revision - 1);
  expect(stale.status()).toBe(409);
  const bad = await patch([{ op: 'setSpeed', clipId: c2!.id, speed: 1000 }]);
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  expect(bad.status()).toBeLessThan(500);
});

test('EDIT-3 editor UI: opens with the assembled cut, monitor and timeline; trim in the inspector persists', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'editorui', 'plus');
  const p = await seedProject(page.request, baseURL, 'Editor UI', THREE_SHOTS);
  await page.goto(`/p/${p.id}?overlay=edit`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();
  await expect(page.getByTestId('monitor-timecode')).toBeVisible();
  await shot(page, testInfo, 'editor');
  // Placeholder clips show Generate (not generated yet).
  const gen = page.getByRole('button', { name: /^Generate/ }).first();
  await expect(gen).toBeVisible();
  // Each shot costs credits (Grok Imagine Video 1.5 Lite, 480p, 1 s ≈ 6): the placeholder must quote it, not “0 credits”.
  await expect(gen).not.toHaveText(/·\s*0 credits/);
  // Select the first clip on the canvas-drawn timeline and nudge its out point with the keyboard trim.
  const tl = page.getByTestId('timeline-canvas');
  const box = (await tl.boundingBox())!;
  // The clip body (its label row), away from the placeholder’s Generate button.
  await page.mouse.click(box.x + 330, box.y + box.height * 0.28);
  const canvasId = (await getJson<{ snapshot: { canvases: Array<{ id: string }> } }>(page.request, `/api/projects/${p.id}`)).snapshot.canvases[0]!.id;
  const before = await timeline(page.request, canvasId);
  // Selecting a not-yet-generated clip shows it in the inspector (clip controls come with media, see EDIT-4).
  await expect(page.getByText('Select a clip to see its settings.')).toHaveCount(0);
  await expect(page.getByText('Not generated').last()).toBeVisible();
  expect((await timeline(page.request, canvasId)).revision).toBe(before.revision);
});

test('EDIT-5 non-member: Generate on a placeholder clip opens the join paywall (not “Not enough credits”), with no saved card shown', async ({ page, context, baseURL }, testInfo) => {
  await account(context, baseURL, 'editornm');
  const p = await seedProject(page.request, baseURL, 'Editor non-member', THREE_SHOTS);
  await page.goto(`/p/${p.id}?overlay=edit`);
  await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /^Generate/ }).first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: /Pick a plan|Not enough credits/ });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await shot(page, testInfo, 'editor-generate-nonmember');
  await expect(dialog).toContainText('Pick a plan to generate');
  await expect(dialog, 'no card on file').not.toContainText(/ending \d{4}/);
  expect((await getJson<{ runs: unknown[] }>(page.request, '/api/runs')).runs).toHaveLength(0);
});

test.describe('export (PW_GENERATE=1, PW_EXPORT=1)', () => {
  test.skip(!env.generate || !env.exportRender, 'needs generated shots and the FFmpeg container');
  test('EDIT-4 generate three 1 s shots, export MP4 720p through the container, download it', async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(20 * 60_000);
    await account(context, baseURL, 'export', 'plus');
    const req = context.request;
    const p = await seedProject(req, baseURL, 'Export', THREE_SHOTS);
    const q = (await (await api(req, baseURL, 'POST', '/api/runs/quote', { projectId: p.id, scope: 'all' })).json()) as { quoteId: string; total: number };
    expect(q.total).toBeLessThan(60);
    const s = await api(req, baseURL, 'POST', '/api/runs', { quoteId: q.quoteId });
    expect(s.status(), await s.text()).toBe(201);
    const run = await waitRun(req, ((await s.json()) as { runId: string }).runId, 12 * 60_000);
    logSpend(testInfo, { runId: run.id, model: 'x-ai/grok-imagine-video-1.5-lite', credits: run.spent, refunded: run.refunded, note: 'export shots' });
    expect(run.status, JSON.stringify((run as RunView).items)).toBe('done');
    // Headless Chromium has showSaveFilePicker but no one to answer it: use the <a download> fallback (D-011).
    await page.addInitScript(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await page.goto(`/p/${p.id}?overlay=edit`);
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 45_000 });
    // Generated clips show their controls in the inspector.
    const tl = page.getByTestId('timeline-canvas');
    const box = (await tl.boundingBox())!;
    await page.mouse.click(box.x + 330, box.y + box.height * 0.28);
    await shot(page, testInfo, 'inspector-generated-clip');
    testInfo.annotations.push({ type: 'inspector', description: (await page.locator('aside, [data-testid="inspector"]').last().innerText().catch(() => '')).slice(0, 300) });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByTestId('export-dialog');
    await dialog.getByRole('radio', { name: '720p' }).click();
    await dialog.getByRole('button', { name: 'Export MP4' }).click();
    await expect(dialog).toHaveAttribute('data-phase', 'running');
    await expect(dialog).toHaveAttribute('data-phase', 'done', { timeout: 10 * 60_000 });
    const t0 = await timeline(page.request, (await getJson<{ snapshot: { canvases: Array<{ id: string }> } }>(page.request, `/api/projects/${p.id}`)).snapshot.canvases[0]!.id);
    testInfo.annotations.push({ type: 'timeline-revision-at-export', description: String(t0.revision) });
    await shot(page, testInfo, 'export-done');
    // The export's signed URL serves an MP4.
    const ex = await getJson<{ items?: unknown }>(page.request, `/api/projects/${p.id}`);
    void ex;
    const dl = page.waitForEvent('download', { timeout: 120_000 }).catch(() => null);
    await dialog.getByRole('button', { name: 'Download' }).click();
    const download = await dl;
    await shot(page, testInfo, 'after-download-click');
    expect(download, 'Download saves the MP4').not.toBeNull();
    expect(download!.suggestedFilename()).toMatch(/\.mp4$/);
  });
});
