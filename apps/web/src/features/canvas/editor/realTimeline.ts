/**
 * Real-mode timeline sync (docs/api.md → Editor): the editor keeps its local
 * reducer (undo, tweening) and mirrors every committed change to the
 * ProjectRoom with `POST /api/canvases/:id/timeline/patch { baseRevision, ops }`,
 * one request at a time. Remote edits arrive as `timeline.patched` on the
 * project channel; the editor then reloads the EDL.
 *
 * The server accepts `trim`, `move`, `split`, `remove`, `setGain`,
 * `setCaption` and `replaceShot`. Commits with other ops (transitions, fades,
 * speed, transforms, insert) and undo steps that need them stay on this
 * device until the API takes them (see report: backend gaps).
 */
import type { Clip, Edl, MediaClip, TimelineOp } from '@rolling/core/timeline';
import { apiFetch, isApiError } from '@/features/overlays/backend';

export const SERVER_OPS = new Set<TimelineOp['op']>(['trim', 'move', 'split', 'remove', 'setGain', 'setCaption', 'replaceShot']);

export interface TimelineState {
  canvasId: string;
  revision: number;
  edl: Edl;
}

export function canvasIdFor(projectId: string): string {
  return `cnv_${projectId.replace(/^prj_/, '')}`;
}

export function fetchTimeline(canvasId: string): Promise<TimelineState> {
  return apiFetch<TimelineState>(`/canvases/${encodeURIComponent(canvasId)}/timeline`);
}

export function reassembleTimeline(canvasId: string): Promise<TimelineState> {
  return apiFetch<TimelineState>(`/canvases/${encodeURIComponent(canvasId)}/timeline/reassemble`, { method: 'POST', body: {} });
}

function clips(edl: Edl): Map<string, { trackId: string; clip: Clip }> {
  const out = new Map<string, { trackId: string; clip: Clip }>();
  for (const t of edl.tracks) for (const c of t.clips) out.set(c.id, { trackId: t.id, clip: c });
  return out;
}

const isMedia = (c: Clip): c is MediaClip => 'in' in c;

/**
 * Ops that turn `from` into `to` using only the server's op set, or null when
 * that is not possible (a clip came back, an effect changed). Used for undo,
 * redo and reset, whose reducer steps carry no ops.
 */
export function timelineDiff(from: Edl, to: Edl): TimelineOp[] | null {
  const a = clips(from);
  const b = clips(to);
  const ops: TimelineOp[] = [];
  for (const [id] of a) if (!b.has(id)) ops.push({ op: 'remove', clipId: id, ripple: false });
  for (const [id, { trackId, clip }] of b) {
    const prev = a.get(id);
    if (!prev || prev.trackId !== trackId) return null;
    const p = prev.clip;
    if (isMedia(clip) && isMedia(p)) {
      if (clip.in !== p.in || clip.out !== p.out) ops.push({ op: 'trim', clipId: id, in: clip.in, out: clip.out });
      if (clip.start !== p.start) ops.push({ op: 'move', clipId: id, start: clip.start });
      if ((clip.gainDb ?? 0) !== (p.gainDb ?? 0)) ops.push({ op: 'setGain', clipId: id, gainDb: clip.gainDb ?? 0 });
      if (clip.assetId !== p.assetId || clip.nodeId !== p.nodeId) {
        if (!clip.nodeId) return null;
        ops.push({ op: 'replaceShot', clipId: id, nodeId: clip.nodeId, ...(clip.assetId ? { assetId: clip.assetId } : {}) });
      }
      const rest = (c: MediaClip) => JSON.stringify({ ...c, in: 0, out: 0, start: 0, gainDb: 0, assetId: null, nodeId: null });
      if (rest(clip) !== rest(p)) return null;
    } else if (!isMedia(clip) && !isMedia(p)) {
      if (clip.text !== p.text) ops.push({ op: 'setCaption', clipId: id, text: clip.text });
      if (clip.start !== p.start || clip.end !== p.end) {
        if (clip.end - clip.start !== p.end - p.start) return null;
        ops.push({ op: 'move', clipId: id, start: clip.start });
      }
    } else return null;
  }
  return ops;
}

export type PushOutcome = 'synced' | 'conflict' | 'invalid' | 'offline';

/** Serial sender: one patch in flight, each based on the last revision the server answered. */
export class TimelineSync {
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  constructor(
    readonly canvasId: string,
    public revision: number,
  ) {}

  get busy() {
    return this.inFlight > 0;
  }

  push(ops: TimelineOp[]): Promise<PushOutcome> {
    if (!ops.length) return Promise.resolve('synced');
    this.inFlight++;
    const run = async (): Promise<PushOutcome> => {
      try {
        const r = await apiFetch<TimelineState & { ops: TimelineOp[] }>(`/canvases/${encodeURIComponent(this.canvasId)}/timeline/patch`, {
          method: 'POST',
          body: { baseRevision: this.revision, ops },
        });
        this.revision = r.revision;
        return 'synced';
      } catch (e) {
        if (isApiError(e, 'CONFLICT')) {
          const t = (e.data as { timeline?: TimelineState }).timeline;
          if (t) this.revision = t.revision;
          return 'conflict';
        }
        if (isApiError(e, 'VALIDATION_FAILED')) return 'invalid';
        return 'offline';
      } finally {
        this.inFlight--;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }
}
