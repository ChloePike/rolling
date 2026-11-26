import type { EditorProject, EditProposal } from './mocks';
import { mockData } from '@/lib/api/mode';
import { assembleFromScript } from '@rolling/core/timeline';
import { planCutTo } from '@rolling/core/timeline';
import { edlDuration, type Edl, type TimelineOp } from '@rolling/core/timeline';
import type { GraphNode } from '@rolling/core/graph';
import { apiFetch, assetMediaUrl, isApiError, isMockApi } from '@/features/overlays/backend';
import { agentFailure, applyProposal, sendTurn, threadFor, type AgentFailure, type Proposal } from '@/features/overlays/agent';
import { getProject, openSession, subscribeProjectMessages } from '../api';
import type { SpecQuote } from '@/features/overlays/runs';
import { canvasIdFor, fetchTimeline, reassembleTimeline } from './realTimeline';
import type { BinItem, ShotInfo } from './mocks';

/**
 * Editor data access. Mock mode: the design's mock project (`mockData().editor`). Real mode: the
 * EDL from `GET /api/canvases/:id/timeline`, shot info from the open canvas'
 * graph, media through signed redirects, agent edits on the project's editor
 * thread (`propose.timelinePatch`).
 */

const BIN_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

function shotFromNode(n: GraphNode): ShotInfo {
  const p = n.params;
  const seconds = typeof p.length === 'number' ? p.length : typeof p.seconds === 'number' ? p.seconds : 5;
  return {
    nodeId: n.id,
    title: n.title,
    model: typeof p.model === 'string' ? p.model : '',
    resolution: typeof p.resolution === 'string' ? p.resolution : '',
    seconds,
    credits: n.cost ?? 0,
  };
}

export interface EditorProjectReal extends EditorProject {
  canvasId: string;
  revision: number;
}

export async function getEditorProject(projectId: string): Promise<EditorProject> {
  if (isMockApi()) return mockData().editor.mockProject(projectId);
  const session = openSession(projectId);
  const canvasId = session?.canvasId() ?? canvasIdFor(projectId);
  const timeline = await fetchTimeline(canvasId);
  const nodes = session?.store.getState().nodes ?? [];
  const videos = nodes.filter((n) => n.kind === 'video');
  const shots = Object.fromEntries(videos.map((n) => [n.id, shotFromNode(n)]));
  const mediaUrls: Record<string, string> = {};
  const audio: EditorProject['audio'] = {};
  for (const t of timeline.edl.tracks) {
    for (const c of t.clips) {
      if (!('assetId' in c) || !c.assetId) continue;
      mediaUrls[c.assetId] = assetMediaUrl(c.assetId);
      if (t.kind === 'voice' || t.kind === 'music') audio[c.assetId] = { assetId: c.assetId, title: t.kind === 'voice' ? 'Voiceover' : 'Music', seconds: c.out, peaks: [0] };
    }
  }
  const bin: BinItem[] = videos.map((n, i) => {
    const media = session?.sync.getMedia(n.id);
    return {
      id: `bin_${n.id}`,
      kind: 'video',
      title: n.title,
      seconds: shotFromNode(n).seconds,
      notGenerated: !media?.assetId,
      color: typeof n.params.tone === 'string' ? n.params.tone : BIN_TONES[i % BIN_TONES.length]!,
      nodeId: n.id,
      ...(media?.assetId ? { assetId: media.assetId } : {}),
    };
  });
  const project: EditorProjectReal = {
    id: projectId,
    title: getProject(projectId).title,
    scriptName: nodes.find((n) => n.kind === 'script')?.title ?? '',
    edl: timeline.edl,
    marks: { in: 0, out: edlDuration(timeline.edl) },
    shots,
    audio,
    bin,
    mediaUrls,
    view: { playhead: 0, selection: null },
    canvasId: timeline.canvasId,
    revision: timeline.revision,
  };
  return project;
}

/** Rebuilds the cut from the current script (real: `POST …/timeline/reassemble`, keeping manual trims). */
export async function reassemble(projectId: string): Promise<Edl> {
  if (isMockApi()) return assembleFromScript(mockData().editor.MOCK_SCRIPT);
  const session = openSession(projectId);
  return (await reassembleTimeline(session?.canvasId() ?? canvasIdFor(projectId))).edl;
}

/** Real mode: ask the editor thread; a `timelinePatch` proposal becomes the proposal card. Throws on agent errors. */
async function proposeEditReal(projectId: string, edl: Edl, request: string): Promise<EditProposal | null> {
  const thread = await threadFor(`editor:${projectId}`, { surface: 'editor', projectId });
  const r = await sendTurn(thread.id, { text: request }, {}, (l) => subscribeProjectMessages(projectId, l));
  const p: Proposal | null = r.proposal;
  if (!p || p.body.kind !== 'timelinePatch') {
    if (r.text) throw new EditorAgentReply(r.text);
    return null;
  }
  const delta = Math.round((p.body.durationBefore - p.body.durationAfter) * 10) / 10;
  return {
    id: p.id,
    request,
    title: p.summary,
    bullets: delta > 0 ? [`${p.body.durationBefore}s → ${p.body.durationAfter}s`] : [],
    note: p.estimate.credits > 0 ? `${p.estimate.credits} credits` : 'Free. Trimmed parts stay recoverable.',
    credits: p.estimate.credits,
    ops: p.body.ops as TimelineOp[],
    highlights: p.body.highlights.map((h) => ({ clipId: h.clipId, kind: h.kind, ...clipSpan(edl, h.clipId) })),
  };
}

/** Timeline span of a clip, for proposal highlights. */
function clipSpan(edl: Edl, clipId: string): { from: number; to: number } {
  for (const t of edl.tracks) {
    for (const c of t.clips) {
      if (c.id !== clipId) continue;
      if ('end' in c) return { from: c.start, to: c.end };
      return { from: c.start, to: c.start + (c.out - c.in) / (c.speed ?? 1) };
    }
  }
  return { from: 0, to: 0 };
}

/** The agent answered with text only (a question or an explanation). */
export class EditorAgentReply extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

export { agentFailure, type AgentFailure };

/** Real mode: applies a timeline proposal as the user; the patched EDL comes back from the server. */
export async function applyEditProposal(projectId: string, proposalId: string): Promise<Edl> {
  await applyProposal(proposalId);
  const session = openSession(projectId);
  return (await fetchTimeline(session?.canvasId() ?? canvasIdFor(projectId))).edl;
}

/** Simulated agent latency for edit requests, ms. */
export const MOCK_AGENT_LATENCY = 450;

let proposalSeq = 0;

/**
 * Asks the agent for an edit. The mock understands “cut to N s”: on the
 * untouched mock cut, “cut to 10s” returns the proposal drawn in
 * CanvasEditAgent.dc.html; otherwise it plans a tail trim. Returns null when
 * the request can't be planned.
 */
export async function proposeEdit(project: EditorProject, edl: Edl, request: string): Promise<EditProposal | null> {
  if (!isMockApi()) return proposeEditReal(project.id, edl, request);
  await new Promise((r) => setTimeout(r, MOCK_AGENT_LATENCY));
  const m = /(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i.exec(request);
  if (!m) return null;
  const target = Number(m[1]);
  const id = `prop_${++proposalSeq}`;
  if (target === 10 && JSON.stringify(edl) === JSON.stringify(project.edl)) {
    return { id, request, ...mockData().editor.MOCK_CUT_TO_10 };
  }
  const plan = planCutTo(edl, target);
  if (!plan) return null;
  const seconds = Math.round((edlDuration(edl) - target) * 10) / 10;
  return {
    id,
    request,
    title: `Trim ${seconds} seconds, no regeneration needed`,
    bullets: ['Later shots slide left to close the gap', 'Captions and audio past the new end are trimmed'],
    note: 'Free. Trimmed parts stay recoverable.',
    credits: 0,
    ops: plan.ops,
    highlights: plan.highlights,
  };
}

export interface RunRequest {
  kind: 'generate' | 'regenerate';
  clipId: string;
  nodeId: string;
  credits: number;
}

/** Real mode: quote regenerating one shot's canvas node (`POST /api/runs/quote { projectId, scope: 'node', nodeIds }`). */
export function quoteNode(projectId: string, nodeId: string): Promise<SpecQuote> {
  return apiFetch<SpecQuote>('/runs/quote', { method: 'POST', body: { projectId, scope: 'node', nodeIds: [nodeId] } });
}

export type RunOutcome = { status: 'done'; nodeId: string; assetId: string } | { status: 'canceled' };

/**
 * TODO(overlays): the canvas mounts the editor with `onRequestRun`, which goes
 * through RunConfirm and the run pipeline. Without it the editor uses this
 * mock, which finishes after a short delay.
 */
export async function mockRun(run: RunRequest): Promise<RunOutcome> {
  await new Promise((r) => setTimeout(r, 1200));
  return { status: 'done', nodeId: run.nodeId, assetId: `ast_${run.nodeId.replace(/^node_/, '')}_${Date.now().toString(36)}` };
}

/* ---------- Export (`POST /api/canvases/:id/export` → ExportWorkflow + FFmpeg; progress over the project socket) ---------- */

export interface ExportOptions {
  /** Whole cut, or the mark in → mark out range. */
  range: 'all' | 'marks';
  marks: { in: number; out: number };
  resolution: '720p' | '1080p';
}

export type ExportEvent =
  | { type: 'started'; exportId: string }
  | { type: 'progress'; progress: number }
  | { type: 'done'; exportId: string; url: string; fileName: string; seconds: number }
  | { type: 'failed'; reason: string; code?: string };

/** `GET /api/exports/:id` → `export` (docs/api.md → Editor). */
export interface ExportView {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  duration: number;
  fileName: string;
  url: string | null;
  error: { code: string; message: string } | null;
}

/** Interval between mock `export.progress` events, ms. */
export const MOCK_EXPORT_TICK = 120;
/** Real mode: status poll while the socket is quiet (missed events, reconnects), ms. */
export const EXPORT_POLL_MS = 4000;

export function getExport(exportId: string): Promise<ExportView> {
  return apiFetch<{ export: ExportView }>(`/exports/${encodeURIComponent(exportId)}`).then((r) => r.export);
}

/** A fresh signed download URL for a finished export (the download's `refreshUrl`). */
export async function exportDownloadUrl(exportId: string): Promise<string | null> {
  return (await getExport(exportId)).url;
}

/**
 * Real mode: starts the export, then follows `export.progress|done|failed`
 * on the project channel, polling `GET /api/exports/:id` as a fallback. The
 * returned function stops following (the render itself finishes on the
 * server and its file stays in the project's assets).
 */
function startExportReal(projectId: string, opts: ExportOptions, onEvent: (e: ExportEvent) => void): () => void {
  let stopped = false;
  let exportId: string | null = null;
  let last = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: () => void = () => {};
  const stop = () => {
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
  };
  const progress = (p: number) => {
    if (p <= last) return;
    last = p;
    onEvent({ type: 'progress', progress: p });
  };
  const finish = (e: ExportEvent) => {
    if (stopped) return;
    stop();
    onEvent(e);
  };
  const fromView = (v: ExportView) => {
    if (stopped) return;
    if (v.status === 'failed') return finish({ type: 'failed', reason: v.error?.message ?? '', ...(v.error ? { code: v.error.code } : {}) });
    if (v.status === 'done' && v.url) return finish({ type: 'done', exportId: v.id, url: v.url, fileName: v.fileName, seconds: v.duration });
    progress(v.progress);
  };
  const poll = () => {
    if (stopped || !exportId) return;
    const id = exportId;
    getExport(id).then(fromView, () => {}).finally(() => {
      if (!stopped) timer = setTimeout(poll, EXPORT_POLL_MS);
    });
  };
  const session = openSession(projectId);
  const canvasId = session?.canvasId() ?? canvasIdFor(projectId);
  const range = opts.range === 'marks' && opts.marks.out > opts.marks.in ? { start: opts.marks.in, end: opts.marks.out } : undefined;
  // Events can arrive before the POST answers: keep them until the id is known.
  const early: { type: string; payload: Record<string, unknown> }[] = [];
  const onMessage = (msg: { type: string; payload: Record<string, unknown> }) => {
    if (!exportId) return void early.push(msg);
    if (msg.payload.exportId !== exportId) return;
    if (msg.type === 'export.progress') progress(Number(msg.payload.progress ?? 0));
    else if (msg.type === 'export.failed') finish({ type: 'failed', reason: String(msg.payload.reason ?? ''), code: String(msg.payload.code ?? '') });
    else if (msg.type === 'export.done') {
      const url = msg.payload.url;
      // Mature exports carry no URL in the broadcast: ask for this viewer's.
      if (typeof url === 'string') finish({ type: 'done', exportId, url, fileName: String(msg.payload.fileName ?? 'export.mp4'), seconds: Number(msg.payload.duration ?? 0) });
      else void getExport(exportId).then(fromView, () => {});
    }
  };
  off = subscribeProjectMessages(projectId, (msg) => {
    if (msg.type.startsWith('export.')) onMessage(msg as { type: string; payload: Record<string, unknown> });
  });
  apiFetch<{ export: ExportView }>(`/canvases/${encodeURIComponent(canvasId)}/export`, {
    method: 'POST',
    body: { preset: opts.resolution === '720p' ? 'mp4_720p' : 'mp4_1080p', ...(range ? { range } : {}) },
  }).then(
    ({ export: v }) => {
      if (stopped) return;
      exportId = v.id;
      onEvent({ type: 'started', exportId: v.id });
      fromView(v);
      for (const m of early.splice(0)) onMessage(m);
      timer = setTimeout(poll, EXPORT_POLL_MS);
    },
    (e: unknown) => {
      const code = isApiError(e) ? e.code : 'NETWORK';
      finish({ type: 'failed', reason: e instanceof Error ? e.message : String(e), code });
    },
  );
  return stop;
}

/**
 * Starts an export and streams its events. Returns a cancel function. Real
 * mode: `POST /api/canvases/:id/export`. The mock renders nothing: the "file"
 * is the EDL as JSON (named so). `?mock=exportfail` fails halfway.
 */
export function startExport(projectId: string, edl: Edl, opts: ExportOptions, onEvent: (e: ExportEvent) => void): () => void {
  if (!isMockApi()) return startExportReal(projectId, opts, onEvent);
  const fail = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === 'exportfail';
  const from = opts.range === 'marks' ? opts.marks.in : 0;
  const to = opts.range === 'marks' ? opts.marks.out : edlDuration(edl);
  let p = 0;
  const timer = setInterval(() => {
    p = Math.min(1, p + 0.1);
    if (fail && p >= 0.5) {
      clearInterval(timer);
      onEvent({ type: 'failed', reason: 'The renderer stopped. Nothing was charged.' });
      return;
    }
    onEvent({ type: 'progress', progress: p });
    if (p >= 1) {
      clearInterval(timer);
      const blob = new Blob([JSON.stringify({ projectId, range: [from, to], resolution: opts.resolution, edl }, null, 2)], { type: 'application/json' });
      const exportId = `exp_${Date.now().toString(36)}`;
      onEvent({ type: 'done', exportId, url: URL.createObjectURL(blob), fileName: `${projectId}-${exportId}.edl.json`, seconds: Math.max(0, to - from) });
    }
  }, MOCK_EXPORT_TICK);
  return () => clearInterval(timer);
}
