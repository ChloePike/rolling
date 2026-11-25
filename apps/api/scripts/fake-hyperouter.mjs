#!/usr/bin/env node
/**
 * Fake Hyperouter for local real end-to-end runs (docs/canvas-flow.md on
 * `wrangler dev`, `PW_REAL_LOCAL=1`). Node, no dependencies. Point the Worker
 * at it with `HYPEROUTER_BASE_URL=http://localhost:<port>/v1` and any
 * `HYPEROUTER_API_KEY`.
 *
 *   node apps/api/scripts/fake-hyperouter.mjs [--port 8799]
 *
 * Implements what the Worker calls (D-002):
 * - `GET /v1/models`: the catalog fixture (packages/core/src/models/__fixtures__).
 * - Images: `POST /v1/images/generations|edits` (202, async) → `GET /v1/generations/:id`.
 * - Video: `POST /v1/videos` → `GET /v1/videos/:id` → `GET /v1/videos/:id/content[?variant=thumbnail]` (302).
 *   Jobs finish `FAKE_HR_DELAY_MS` (default 1500) after they are created; the outputs are small
 *   fixture files served from `/files/*`. A prompt containing `[fail]` fails with `content_rejected`.
 *   `Idempotency-Key` is honoured (the same key returns the same job).
 * - Webhooks: when a job finishes, a Standard-Webhooks-signed `image.completed|failed` /
 *   `video.completed|failed` event is POSTed to `FAKE_HR_WEBHOOK_URL` (default
 *   http://localhost:8797/api/hooks/hyperouter) with `FAKE_HR_WEBHOOK_SECRET` (whsec_…); set
 *   `FAKE_HR_WEBHOOK_URL=off` to rely on polling only.
 * - `POST /v1/chat/completions` (SSE or JSON): scripted replies. Agent turns (requests with tools)
 *   answer the golden briefs with valid proposals: `propose.plan` (2 options that add up to the
 *   asked length), `canvas.get` → `propose.graphPatch` ("make shot 2 warmer"), `timeline.get` →
 *   `propose.timelinePatch` ("cut to 10s"), `propose.fields` (tool pages). Classifier calls get
 *   valid JSON: Auto model choice (the first candidate), text and image safety ratings (safe),
 *   face detection (no faces).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argPort = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : undefined;
const PORT = argPort ?? Number(process.env.FAKE_HR_PORT ?? 8799);
const DELAY_MS = Number(process.env.FAKE_HR_DELAY_MS ?? 1500);
const WEBHOOK_URL = process.env.FAKE_HR_WEBHOOK_URL ?? 'http://localhost:8797/api/hooks/hyperouter';
const WEBHOOK_SECRET = process.env.FAKE_HR_WEBHOOK_SECRET ?? `whsec_${Buffer.from('rolling-fake-hyperouter-webhook-key!').toString('base64')}`;
const QUIET = process.env.FAKE_HR_QUIET === '1';

const LISTING = readFileSync(join(HERE, '../../../packages/core/src/models/__fixtures__/hyperouter-models.json'), 'utf8');
const MP4 = readFileSync(join(HERE, 'fixtures/fake-hyperouter.mp4'));
const PNG = readFileSync(join(HERE, 'fixtures/fake-hyperouter.png'));

const log = (...m) => {
  if (!QUIET) console.log('[fake-hyperouter]', ...m);
};

/** @type {Map<string, {id: string, kind: 'image'|'video', model: string, createdAt: number, fail: boolean, seconds: number, webhookSent: boolean}>} */
const jobs = new Map();
const byKey = new Map();
let seq = 0;

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function base(req) {
  return `http://${req.headers.host ?? `localhost:${PORT}`}`;
}

// ------------------------------------------------------------------ jobs

function createJob(kind, body, key) {
  if (key && byKey.has(key)) return jobs.get(byKey.get(key));
  const id = `${kind === 'video' ? 'vid' : 'gen'}_fake${(++seq).toString(36)}${randomUUID().slice(0, 6)}`;
  const prompt = String(body.prompt ?? '');
  const job = { id, kind, model: String(body.model ?? ''), createdAt: Date.now(), fail: /\[fail\]/i.test(prompt), seconds: Number(body.seconds ?? 5) || 5, webhookSent: false };
  jobs.set(id, job);
  if (key) byKey.set(key, id);
  log('create', kind, id, job.model, key ?? '');
  setTimeout(() => void webhook(job), DELAY_MS + 50);
  return job;
}

const finished = (job) => Date.now() - job.createdAt >= DELAY_MS;
const progressOf = (job) => Math.min(95, Math.round(((Date.now() - job.createdAt) / DELAY_MS) * 100));
const costOf = (job) => (job.kind === 'video' ? Math.round(job.seconds * 0.02 * 1000) / 1000 : 0.01);

function generationView(req, job) {
  if (!finished(job)) return { data: { id: job.id, kind: job.kind, status: 'running' } };
  if (job.fail) return { data: { id: job.id, kind: job.kind, status: 'failed', error: { code: 'content_rejected', message: 'The provider rejected the content.' } } };
  return { data: { id: job.id, kind: job.kind, status: 'done', usage: { cost: costOf(job) }, outputs: [{ url: `${base(req)}/files/${job.id}.png` }] } };
}

function videoView(job) {
  if (!finished(job)) return { id: job.id, object: 'video', status: 'in_progress', progress: progressOf(job) };
  if (job.fail) return { id: job.id, object: 'video', status: 'failed', error: { code: 'content_rejected', message: 'The provider rejected the content.' } };
  return { id: job.id, object: 'video', status: 'completed', progress: 100, completed_at: Math.floor(Date.now() / 1000), usage: { cost: costOf(job), seconds: job.seconds } };
}

/** Standard Webhooks: `v1,` + base64 HMAC-SHA256 of `id.timestamp.body` with the base64 key after `whsec_`. */
function sign(id, ts, body) {
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

async function webhook(job) {
  if (WEBHOOK_URL === 'off' || job.webhookSent) return;
  job.webhookSent = true;
  const type = `${job.kind}.${job.fail ? 'failed' : 'completed'}`;
  const id = `msg_${randomUUID().replace(/-/g, '')}`;
  const body = JSON.stringify({ id: `evt_${id}`, object: 'event', type, created_at: Math.floor(Date.now() / 1000), data: { id: job.id } });
  const ts = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(id, ts, body) }, body });
    log('webhook', type, job.id, r.status);
  } catch (err) {
    log('webhook failed', type, job.id, String(err));
  }
}

// ------------------------------------------------------------------ chat

const text = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '');

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return { index: i, text: text(messages[i]) };
  return { index: -1, text: '' };
}

/** Tool calls the assistant made after the last user message, with their results. */
function callsSince(messages, from) {
  const out = [];
  for (let i = from + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) out.push({ id: c.id, name: c.function?.name, args: c.function?.arguments });
    if (m.role === 'tool') {
      const c = out.find((x) => x.id === m.tool_call_id);
      if (c) c.result = text(m);
    }
  }
  return out;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function findId(messages, re) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = re.exec(text(messages[i]));
    if (m) return m[0];
  }
  return null;
}

const VIDEO_MODEL = process.env.FAKE_HR_PLAN_MODEL ?? 'bytedance/seedance-2.0-mini';

/** Two plan options whose shots add up to the asked length. */
function planFor(brief) {
  const m = /(\d{1,3})\s*-?\s*(?:s\b|sec|second)/i.exec(brief);
  const total = m ? Math.max(4, Math.min(120, Number(m[1]))) : 15;
  const vertical = /vertical|9:16|reel|story|tiktok/i.test(brief) || !/widescreen|16:9|landscape/i.test(brief);
  const ratio = vertical ? '9:16' : '16:9';
  const split = (n) => {
    const each = Math.max(4, Math.round(total / n));
    const shots = Array.from({ length: n }, () => each);
    shots[n - 1] = Math.max(4, total - each * (n - 1));
    return shots;
  };
  const subject = brief.replace(/\s+/g, ' ').trim().slice(0, 120) || 'the product';
  const visuals = ['Establishing shot at dawn, soft light', 'Close-up of the product, condensation and detail', 'The logo and tagline over a clean background'];
  const option = (title, n) => ({
    title,
    ratio,
    resolution: '480p',
    shots: split(n).map((seconds, i) => ({ title: `Shot ${i + 1}`, seconds, visual: `${visuals[i % visuals.length]}. ${subject}`, line: i === n - 1 ? 'Fresh from the source.' : undefined, model: VIDEO_MODEL })),
  });
  return { seconds: total, options: [option('Three beats', 3), option('Two beats', 2)], summary: `Two ways to cover ${total} seconds.` };
}

function graphPatchFor(messages, ask, canvas) {
  const view = parseJson(canvas ?? '') ?? {};
  const nodes = Array.isArray(view.nodes) ? view.nodes : [];
  const videos = nodes.filter((n) => n.kind === 'video');
  const images = nodes.filter((n) => n.kind === 'image');
  const pool = videos.length ? videos : images.length ? images : nodes;
  const shot = /shot\s*(\d+)/i.exec(ask);
  const target = pool[shot ? Math.min(pool.length, Math.max(1, Number(shot[1]))) - 1 : 0] ?? pool[0];
  const projectId = findId(messages, /prj_[A-Za-z0-9]+/) ?? '';
  const mood = /cool|cold|blue/i.test(ask) ? 'cooler, blue-hour light' : /warm/i.test(ask) ? 'warmer, golden-hour light' : 'adjusted as asked';
  if (!target) return null;
  const prompt = typeof target.params?.prompt === 'string' ? target.params.prompt : '';
  return {
    projectId,
    baseRevision: Number(view.revision ?? 0),
    ops: [{ op: 'updateNode', nodeId: target.id, params: { prompt: `${prompt ? `${prompt.replace(/[.\s]+$/, '')}, ` : ''}${mood}` } }],
    summary: `${target.title}: ${mood}.`,
  };
}

function timelinePatchFor(messages, ask, timeline) {
  const view = parseJson(timeline ?? '') ?? {};
  const canvasId = findId(messages, /cnv_[A-Za-z0-9_-]+/) ?? '';
  const want = /(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i.exec(ask);
  const duration = Number(view.duration ?? 0);
  const clips = (view.tracks ?? []).flatMap((t) => (t.kind === 'video' ? (t.clips ?? []) : [])).filter((c) => typeof c.in === 'number');
  const last = clips.sort((a, b) => b.end - a.end)[0];
  if (!last) return null;
  const target = want ? Number(want[1]) : Math.max(1, duration - 1);
  const excess = Math.max(0.5, duration - target);
  const out = Math.max(last.in + 0.5, last.out - excess);
  return { canvasId, baseRevision: Number(view.revision ?? 0), ops: [{ op: 'trim', clipId: last.id, out: Math.round(out * 100) / 100 }], summary: `Trim the last clip so the cut runs about ${target}s.` };
}

/** What the scripted agent does next: a tool call or the final text. */
function agentStep(body) {
  const messages = body.messages ?? [];
  const tools = new Set((body.tools ?? []).map((t) => t.function?.name));
  const user = lastUser(messages);
  const calls = callsSince(messages, user.index);
  const called = (name) => calls.find((c) => c.name === name);
  const call = (name, input) => ({ tool: { name, arguments: JSON.stringify(input) } });

  if (tools.has('propose__plan') && !tools.has('propose__graphPatch')) {
    if (!called('propose__plan')) return call('propose__plan', planFor(user.text));
    return { text: 'Here are two options. Pick one and build it on the canvas.' };
  }
  if (tools.has('propose__graphPatch')) {
    if (/\b(plan|ad|brief|storyboard)\b/i.test(user.text) && !/shot\s*\d|warmer|cooler|brighter|darker/i.test(user.text) && tools.has('propose__plan')) {
      if (!called('propose__plan')) return call('propose__plan', planFor(user.text));
      return { text: 'Here are two options.' };
    }
    const projectId = findId(messages, /prj_[A-Za-z0-9]+/);
    const get = called('canvas__get');
    if (!get && projectId) return call('canvas__get', { projectId });
    if (!called('propose__graphPatch')) {
      const patch = graphPatchFor(messages, user.text, get?.result);
      if (patch) return call('propose__graphPatch', patch);
    }
    return { text: 'Proposed the change. Apply it to update the canvas.' };
  }
  if (tools.has('propose__timelinePatch')) {
    const canvasId = findId(messages, /cnv_[A-Za-z0-9_-]+/);
    const get = called('timeline__get');
    if (!get && canvasId) return call('timeline__get', { canvasId });
    if (!called('propose__timelinePatch')) {
      const patch = timelinePatchFor(messages, user.text, get?.result);
      if (patch) return call('propose__timelinePatch', patch);
    }
    return { text: 'Proposed a tighter cut. Apply it to update the timeline.' };
  }
  if (tools.has('propose__fields')) {
    if (!called('propose__fields')) {
      const sys = text(messages[0]);
      const tool = /\b(remix|avatar|character)\b/i.exec(sys)?.[1]?.toLowerCase() ?? 'quick';
      const prompt = `${user.text.replace(/[.\s]+$/, '')}. Steady camera, soft natural light.`;
      const fields = tool === 'avatar' ? { script: prompt } : tool === 'character' ? { name: 'New character', look: prompt } : { kind: 'video', prompt };
      return call('propose__fields', { tool, fields });
    }
    return { text: 'Filled in the fields.' };
  }
  return { text: 'Done.' };
}

/** Classifier and utility calls (no tools): valid JSON for each kind. */
function classifierAnswer(body) {
  const messages = body.messages ?? [];
  const sys = text(messages[0]);
  const user = messages.find((m) => m.role === 'user');
  if (body.model === 'lumina/face-detect') return JSON.stringify({ faces: [] });
  if (/choose the generation model/i.test(sys)) {
    const input = parseJson(text(user)) ?? {};
    return JSON.stringify({ modelId: input.candidates?.[0]?.id ?? '' });
  }
  if (/content-safety classifier/i.test(sys) && /rate images/i.test(sys)) {
    const n = Array.isArray(user?.content) ? user.content.filter((p) => p.type === 'image_url').length : 1;
    return JSON.stringify({ images: Array.from({ length: Math.max(1, n) }, () => ({ rating: 'safe', confidence: 0.99, photographic: false, apparentMinor: false, minorSexualized: false, knownPerson: false, extremeViolence: false, violentExtremism: false, selfHarm: false })) });
  }
  if (/content-safety classifier/i.test(sys)) {
    return JSON.stringify({ sexualLevel: 'none', apparentMinor: false, minorSexualized: false, realPerson: false, realPersonNames: [], realPersonSexualOrIntimate: false, nonConsensualSexual: false, extremeViolence: false, violentExtremism: false, selfHarm: false });
  }
  if (body.response_format?.type === 'json_object') return '{}';
  return 'Summary: the user is making a short video.';
}

const USAGE = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.0002 };

function chat(req, res, body) {
  const step = body.tools?.length ? agentStep(body) : { text: classifierAnswer(body) };
  const id = `chatcmpl-fake${(++seq).toString(36)}`;
  const model = body.model ?? 'deepseek/deepseek-v4.1-flash';
  log('chat', model, step.tool ? `→ ${step.tool.name}` : `→ text ${step.text.slice(0, 60)}`);
  if (body.stream === false) {
    const message = step.tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${seq}`, type: 'function', function: step.tool }] }
      : { role: 'assistant', content: step.text };
    return send(res, 200, { id, object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: USAGE });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices, ...extra })}\n\n`);
  if (step.tool) {
    chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: step.tool.name, arguments: '' } }] }, finish_reason: null }]);
    const a = step.tool.arguments;
    for (let i = 0; i < a.length; i += 400) chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(i, i + 400) } }] }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  } else {
    for (const part of step.text.match(/[\s\S]{1,24}/g) ?? ['']) chunk([{ index: 0, delta: { content: part }, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  }
  chunk([], { usage: USAGE });
  res.end('data: [DONE]\n\n');
}

// ------------------------------------------------------------------ server

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', base(req));
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const key = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : null;
  try {
    if (req.method === 'GET' && (path === '/health' || path === '/')) return send(res, 200, { ok: true, jobs: jobs.size });
    if (req.method === 'GET' && path === '/v1/models') return send(res, 200, LISTING, { 'content-type': 'application/json' });
    if (req.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits')) {
      const body = await readJson(req);
      const job = createJob('image', body, key);
      return send(res, 202, { id: job.id, status: 'queued' });
    }
    if (req.method === 'POST' && path === '/v1/videos') {
      const body = await readJson(req);
      const job = createJob('video', body, key);
      return send(res, 200, { id: job.id, object: 'video', status: 'queued', progress: 0, model: job.model });
    }
    let m = /^\/v1\/generations\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      return job ? send(res, 200, generationView(req, job)) : send(res, 404, { error: { message: 'not found', code: 'not_found' } });
    }
    m = /^\/v1\/videos\/([^/]+)\/content$/.exec(path);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      if (!job || !finished(job) || job.fail) return send(res, 404, { error: { message: 'not ready', code: 'not_found' } });
      const thumb = url.searchParams.get('variant') === 'thumbnail';
      res.writeHead(302, { location: `${base(req)}/files/${job.id}.${thumb ? 'png' : 'mp4'}` });
      return res.end();
    }
    m = /^\/v1\/videos\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      return job ? send(res, 200, videoView(job)) : send(res, 404, { error: { message: 'not found', code: 'not_found' } });
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') return chat(req, res, await readJson(req));
    m = /^\/files\/[^/]+\.(png|mp4)$/.exec(path);
    if (req.method === 'GET' && m) {
      const png = m[1] === 'png';
      return send(res, 200, png ? PNG : MP4, { 'content-type': png ? 'image/png' : 'video/mp4', 'content-length': String((png ? PNG : MP4).length) });
    }
    return send(res, 404, { error: { message: `fake: no route ${req.method} ${path}`, code: 'not_found' } });
  } catch (err) {
    log('error', String(err));
    return send(res, 500, { error: { message: String(err), code: 'internal_error' } });
  }
});

server.listen(PORT, () => log(`listening on http://localhost:${PORT}/v1 (webhooks → ${WEBHOOK_URL})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
