/**
 * Compact JSON views of canvas, timeline and models for tool results and the
 * context. Drops UI-only params and keeps strings short.
 */
import type { GraphEdge, GraphNode, GraphState } from '@rolling/core/graph';
import { clipEnd, edlDuration, isCaptionClip, type Clip, type Edl } from '@rolling/core/timeline';

/** Params the canvas stores for display only. */
const UI_PARAMS = new Set(['tone', 'wave', 'quick', 'versionLabel', 'runCost', 'extra', 'label']);

function shorten(v: unknown, max: number): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 24).map((x) => shorten(x, max));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = shorten(x, max);
    return out;
  }
  return v;
}

export function compactParams(params: Record<string, unknown>, maxString = 600): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (UI_PARAMS.has(k) || v === null || v === undefined) continue;
    out[k] = shorten(v, maxString);
  }
  return out;
}

export function compactNode(n: GraphNode, assets: Record<string, string> = {}): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    status: n.status,
    params: compactParams(n.params),
    ...(n.version ? { version: `${n.version.n}/${n.version.total}` } : {}),
    ...(assets[n.id] ? { asset: assets[n.id] } : {}),
    ...(n.cost !== undefined ? { cost: n.cost } : {}),
    by: n.createdBy,
  };
}

export function compactEdge(e: GraphEdge): Record<string, unknown> {
  return { id: e.id, from: `${e.from.node}.${e.from.port}`, to: `${e.to.node}.${e.to.port}` };
}

/** One line per node for the context: id, kind, title, model, status. */
export function nodeLine(n: GraphNode): string {
  const p = n.params;
  const bits = [n.id, n.kind, JSON.stringify(n.title)];
  if (typeof p.model === 'string') bits.push(`model=${p.model}`);
  if (p.seconds !== undefined) bits.push(`${String(p.seconds)}s`);
  if (typeof p.prompt === 'string') bits.push(`prompt=${JSON.stringify(p.prompt.slice(0, 80))}`);
  bits.push(n.status);
  if (n.version) bits.push(`v${n.version.n}`);
  return bits.join(' ');
}

export function canvasView(state: GraphState, assets: Record<string, string>, nodeIds?: readonly string[]) {
  const only = nodeIds?.length ? new Set(nodeIds) : null;
  const nodes = state.nodes.filter((n) => !only || only.has(n.id));
  const edges = state.edges.filter((e) => !only || only.has(e.from.node) || only.has(e.to.node));
  return { revision: state.revision, nodes: nodes.map((n) => compactNode(n, assets)), edges: edges.map(compactEdge) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** EDL summary: tracks, clips with ids and times, gaps on each track, total duration. */
export function timelineView(revision: number, edl: Edl) {
  return {
    revision,
    duration: r2(edlDuration(edl)),
    fps: edl.fps,
    tracks: edl.tracks.map((t) => {
      const clips = [...(t.clips as Clip[])].sort((a, b) => a.start - b.start);
      const gaps: [number, number][] = [];
      let cursor = 0;
      for (const c of clips) {
        if (c.start > cursor + 0.01) gaps.push([r2(cursor), r2(c.start)]);
        cursor = Math.max(cursor, clipEnd(c));
      }
      return {
        id: t.id,
        kind: t.kind,
        clips: clips.map((c) =>
          isCaptionClip(c)
            ? { id: c.id, start: r2(c.start), end: r2(c.end), text: c.text }
            : {
                id: c.id,
                start: r2(c.start),
                end: r2(clipEnd(c)),
                in: r2(c.in),
                out: r2(c.out),
                ...(c.nodeId ? { nodeId: c.nodeId } : {}),
                ...(c.gainDb !== undefined ? { gainDb: c.gainDb } : {}),
                ...(c.assetId ? {} : { placeholder: true }),
              },
        ),
        ...(gaps.length ? { gaps } : {}),
      };
    }),
  };
}
