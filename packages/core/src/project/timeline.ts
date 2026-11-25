/**
 * First assembly of the editor's EDL from a graph. The timeline op and EDL
 * schemas live in `@rolling/core/timeline` (one schema for client and
 * server); they are re-exported here for existing imports.
 */
import type { GraphState } from '../graph/types';
import { assembleFromScript, type ScriptShot } from '../timeline/assemble';
import type { Edl, MediaClip } from '../timeline/types';

export { TimelineOpSchema, TimelinePatchSchema, parseTimelineOps, EdlSchema, parseEdl } from '../timeline/schema';

const DEFAULT_SHOT_SECONDS = 5;

function shotSeconds(params: Record<string, unknown>): number {
  for (const key of ['duration', 'seconds']) {
    const v = params[key];
    if (typeof v === 'number' && v > 0 && v <= 600) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?s?$/.test(v)) return Number.parseFloat(v);
  }
  return DEFAULT_SHOT_SECONDS;
}

const RATIO_SIZE: Record<string, [number, number]> = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
};

interface ScriptRow {
  n?: string | number;
  visual?: string;
  line?: string;
  seconds?: number;
  nodeId?: string;
  selected?: boolean;
}

function scriptRows(params: Record<string, unknown>): ScriptRow[] {
  const rows = params.rows;
  return Array.isArray(rows) ? rows.filter((r): r is ScriptRow => !!r && typeof r === 'object') : [];
}

function captionText(line: string | undefined): string | null {
  const t = (line ?? '').trim().replace(/^[“"']+|[”"']+$/g, '').trim();
  return t ? t : null;
}

/**
 * First cut from the graph. With a script node, its rows (`params.rows`:
 * `{ n, visual, line?, seconds, nodeId? }`) are the shots in order: each row
 * maps to its `nodeId` or else to the video nodes left to right; a row's
 * `line` becomes a caption. Without a script: the video nodes feeding a
 * render node (edge order), else every video node left to right. An audio
 * node with a generated asset becomes the voiceover (`params.role: 'music'`
 * puts it on the music track). `assetOf` gives a node's active asset.
 */
export function assembleFromGraph(state: GraphState, assetOf: (nodeId: string) => string | null): Edl {
  const byPosition = (a: { position: { x: number; y: number } }, b: { position: { x: number; y: number } }) =>
    a.position.x - b.position.x || a.position.y - b.position.y;
  const render = state.nodes.find((n) => n.kind === 'render');
  const allVideos = state.nodes.filter((n) => n.kind === 'video').sort(byPosition);
  let videos = render
    ? state.edges
        .filter((e) => e.to.node === render.id && e.to.port === 'clips')
        .map((e) => state.nodes.find((n) => n.id === e.from.node))
        .filter((n): n is NonNullable<typeof n> => !!n && n.kind === 'video')
    : [];
  if (!videos.length) videos = allVideos;

  const script = state.nodes.filter((n) => n.kind === 'script').sort(byPosition).find((n) => scriptRows(n.params).length > 0);
  let shots: ScriptShot[];
  if (script) {
    const rows = scriptRows(script.params).filter((r) => r.selected !== false);
    const unused = videos.filter((v) => !rows.some((r) => r.nodeId === v.id));
    shots = rows.map((row, i) => {
      const node = (row.nodeId ? state.nodes.find((n) => n.id === row.nodeId) : undefined) ?? unused.shift();
      const seconds = typeof row.seconds === 'number' && row.seconds > 0 ? row.seconds : node ? shotSeconds(node.params) : DEFAULT_SHOT_SECONDS;
      const text = captionText(row.line);
      return {
        nodeId: node?.id ?? `${script.id}#${row.n ?? i + 1}`,
        assetId: node ? assetOf(node.id) : null,
        seconds,
        ...(text ? { caption: { text, at: 0 } } : {}),
      };
    });
  } else {
    shots = videos.map((n) => ({ nodeId: n.id, assetId: assetOf(n.id), seconds: shotSeconds(n.params) }));
  }

  const audio = state.nodes.filter((n) => n.kind === 'audio').sort(byPosition);
  const voiceNode = audio.find((n) => n.params.role !== 'music' && assetOf(n.id));
  const musicNode = audio.find((n) => n.params.role === 'music' && assetOf(n.id));
  const ratio =
    (typeof render?.params.ratio === 'string' ? render.params.ratio : undefined) ??
    (typeof videos[0]?.params.ratio === 'string' ? (videos[0].params.ratio as string) : undefined);
  const [width, height] = RATIO_SIZE[ratio ?? '9:16'] ?? RATIO_SIZE['9:16']!;
  return assembleFromScript({
    fps: 30,
    width,
    height,
    shots,
    ...(voiceNode ? { voiceover: { assetId: assetOf(voiceNode.id)!, seconds: shotSeconds(voiceNode.params), at: 0 } } : {}),
    ...(musicNode ? { music: { assetId: assetOf(musicNode.id)!, seconds: shotSeconds(musicNode.params), gainDb: -12 } } : {}),
  });
}

/**
 * Rebuilds from the graph but keeps manual trims of shots that still exist
 * (same node): their `in`/`out` carry over and shots stay back to back.
 */
export function reassemble(previous: Edl, state: GraphState, assetOf: (nodeId: string) => string | null): Edl {
  const fresh = assembleFromGraph(state, assetOf);
  const oldShots = new Map<string, MediaClip>();
  for (const t of previous.tracks) if (t.kind === 'video') for (const c of t.clips) if (c.nodeId) oldShots.set(c.nodeId, c);
  for (const t of fresh.tracks) {
    if (t.kind !== 'video') continue;
    let start = 0;
    for (const c of t.clips) {
      const old = c.nodeId ? oldShots.get(c.nodeId) : undefined;
      if (old && old.out > old.in) {
        c.in = old.in;
        c.out = old.out;
      }
      c.start = Math.round(start * 1e6) / 1e6;
      start += c.out - c.in;
    }
  }
  // Keep other tracks the user built (voice, music, captions) when the new cut has none.
  fresh.tracks = fresh.tracks.map((t) => {
    if (t.kind === 'video' || t.clips.length) return t;
    const prev = previous.tracks.find((p) => p.id === t.id && p.kind === t.kind);
    return prev ?? t;
  });
  return fresh;
}
