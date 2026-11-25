import { MOCK_CUT_TO_10, MOCK_SCRIPT, mockProject, type EditorProject, type EditProposal } from './mocks';
import { assembleFromScript } from '@rolling/core/timeline';
import { planCutTo } from '@rolling/core/timeline';
import { edlDuration, type Edl } from '@rolling/core/timeline';

/**
 * Editor data access. Mock for now; the real client reads the ProjectRoom
 * snapshot over the project socket and sends agent requests through the
 * AgentSession (`proposal.created`). Keep this surface small so it can be swapped.
 */

export async function getEditorProject(projectId: string): Promise<EditorProject> {
  return mockProject(projectId);
}

/** Rebuilds the cut from the current script (the agent's assemble step). */
export async function reassemble(_projectId: string): Promise<Edl> {
  return assembleFromScript(MOCK_SCRIPT);
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
  await new Promise((r) => setTimeout(r, MOCK_AGENT_LATENCY));
  const m = /(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i.exec(request);
  if (!m) return null;
  const target = Number(m[1]);
  const id = `prop_${++proposalSeq}`;
  if (target === 10 && JSON.stringify(edl) === JSON.stringify(project.edl)) {
    return { id, request, ...MOCK_CUT_TO_10 };
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

/* ---------- Export (`POST /api/projects/:id/exports` → ExportWorkflow + FFmpeg; progress over the project socket) ---------- */

export interface ExportOptions {
  /** Whole cut, or the mark in → mark out range. */
  range: 'all' | 'marks';
  marks: { in: number; out: number };
  resolution: '720p' | '1080p';
}

export type ExportEvent =
  | { type: 'progress'; progress: number }
  | { type: 'done'; exportId: string; url: string; fileName: string; seconds: number }
  | { type: 'failed'; reason: string };

/** Interval between mock `export.progress` events, ms. */
export const MOCK_EXPORT_TICK = 120;

/**
 * Starts an export and streams its events. Returns a cancel function. The
 * mock renders nothing: the "file" is the EDL as JSON (named so), so the
 * download link works end to end until the FFmpeg container is wired.
 * `?mock=exportfail` fails halfway.
 */
export function startExport(projectId: string, edl: Edl, opts: ExportOptions, onEvent: (e: ExportEvent) => void): () => void {
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
