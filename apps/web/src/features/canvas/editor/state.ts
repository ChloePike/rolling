import type { EditProposal } from './mocks';
import { DEFAULT_PPS } from '@rolling/core/timeline';
import { applyOps, type ApplyOptions } from '@rolling/core/timeline';
import type { Edl, TimelineOp } from '@rolling/core/timeline';

export type Tool = 'select' | 'razor' | 'slip' | 'text' | 'hand';

export interface TrackFlags {
  hidden: boolean;
  muted: boolean;
  locked: boolean;
}

export interface ChangeInfo {
  /** Bumps on every timeline change. */
  version: number;
  /** Whether the canvas tweens clips from their previous place (slow, 320ms). */
  animate: boolean;
  /** Timeline before this change, for the tween. */
  previous: Edl | null;
}

export type ProposalPhase = 'idle' | 'pending' | 'open' | 'error';

export interface EditorState {
  edl: Edl;
  past: Edl[];
  future: Edl[];
  change: ChangeInfo;
  selection: string | null;
  tool: Tool;
  snapping: boolean;
  pps: number;
  scrollX: number;
  marks: { in: number; out: number };
  /** Timeline markers (seconds), sorted. */
  markers: number[];
  tracks: Record<string, TrackFlags>;
  proposal: EditProposal | null;
  proposalPhase: ProposalPhase;
  /** Clips with a generation in flight. */
  running: string[];
  coalesceKey: string | null;
}

export type EditorAction =
  | {
      type: 'commit';
      ops: TimelineOp[];
      animate: boolean;
      select?: string | null;
      /** Consecutive commits with the same key (a fader drag) share one undo step. */
      coalesce?: string;
    }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; edl: Edl }
  | { type: 'select'; clipId: string | null }
  | { type: 'tool'; tool: Tool }
  | { type: 'snapping'; on: boolean }
  | { type: 'view'; pps?: number; scrollX?: number }
  | { type: 'mark'; edge: 'in' | 'out'; time: number }
  /** Adds a marker at `time`, or removes the one already there. */
  | { type: 'marker'; time: number }
  /** Output format (frame size and rate); undoable like a timeline edit. */
  | { type: 'format'; width: number; height: number; fps: number }
  | { type: 'trackFlag'; trackId: string; flag: keyof TrackFlags }
  | { type: 'proposalPending' }
  | { type: 'proposal'; proposal: EditProposal | null }
  | { type: 'proposalClose' }
  | { type: 'running'; clipId: string; on: boolean };

const HISTORY_LIMIT = 100;

export function initEditorState(edl: Edl, marks: { in: number; out: number }, selection: string | null): EditorState {
  return {
    edl,
    past: [],
    future: [],
    change: { version: 0, animate: false, previous: null },
    selection,
    tool: 'select',
    snapping: true,
    pps: DEFAULT_PPS,
    scrollX: 0,
    marks,
    markers: [],
    tracks: Object.fromEntries(edl.tracks.map((t) => [t.id, { hidden: false, muted: false, locked: false }])),
    proposal: null,
    proposalPhase: 'idle',
    running: [],
    coalesceKey: null,
  };
}

function withEdl(state: EditorState, edl: Edl, animate: boolean, history: { past: Edl[]; future: Edl[] }): EditorState {
  return {
    ...state,
    ...history,
    edl,
    change: { version: state.change.version + 1, animate, previous: state.edl },
    coalesceKey: null,
  };
}

export function makeReducer(opts: ApplyOptions) {
  return function reducer(state: EditorState, action: EditorAction): EditorState {
    switch (action.type) {
      case 'commit': {
        const result = applyOps(state.edl, action.ops, opts);
        if (!result.ok) return state;
        const merge = action.coalesce !== undefined && action.coalesce === state.coalesceKey;
        const next = withEdl(state, result.edl, action.animate, {
          past: merge ? state.past : [...state.past, state.edl].slice(-HISTORY_LIMIT),
          future: [],
        });
        next.coalesceKey = action.coalesce ?? null;
        return action.select === undefined ? next : { ...next, selection: action.select };
      }
      case 'undo': {
        const prev = state.past[state.past.length - 1];
        if (!prev) return state;
        return withEdl(state, prev, true, { past: state.past.slice(0, -1), future: [state.edl, ...state.future] });
      }
      case 'redo': {
        const [next, ...rest] = state.future;
        if (!next) return state;
        return withEdl(state, next, true, { past: [...state.past, state.edl], future: rest });
      }
      case 'reset':
        return withEdl(state, action.edl, true, { past: [...state.past, state.edl].slice(-HISTORY_LIMIT), future: [] });
      case 'select':
        return state.selection === action.clipId ? state : { ...state, selection: action.clipId };
      case 'tool':
        return { ...state, tool: action.tool };
      case 'snapping':
        return { ...state, snapping: action.on };
      case 'view':
        return { ...state, pps: action.pps ?? state.pps, scrollX: action.scrollX ?? state.scrollX };
      case 'mark':
        return { ...state, marks: { ...state.marks, [action.edge]: action.time } };
      case 'marker': {
        const near = state.markers.find((m) => Math.abs(m - action.time) < 1 / state.edl.fps / 2 + 1e-6);
        const markers = near !== undefined ? state.markers.filter((m) => m !== near) : [...state.markers, action.time].sort((a, b) => a - b);
        return { ...state, markers };
      }
      case 'format': {
        const { width, height, fps } = action;
        if (width === state.edl.width && height === state.edl.height && fps === state.edl.fps) return state;
        return withEdl(state, { ...state.edl, width, height, fps }, false, { past: [...state.past, state.edl].slice(-HISTORY_LIMIT), future: [] });
      }
      case 'trackFlag': {
        const flags = state.tracks[action.trackId];
        if (!flags) return state;
        return { ...state, tracks: { ...state.tracks, [action.trackId]: { ...flags, [action.flag]: !flags[action.flag] } } };
      }
      case 'proposalPending':
        return { ...state, proposalPhase: 'pending' };
      case 'proposal':
        return action.proposal
          ? { ...state, proposal: action.proposal, proposalPhase: 'open' }
          : { ...state, proposal: null, proposalPhase: 'error' };
      case 'proposalClose':
        return { ...state, proposal: null, proposalPhase: 'idle' };
      case 'running':
        return {
          ...state,
          running: action.on ? [...state.running, action.clipId] : state.running.filter((id) => id !== action.clipId),
        };
    }
  };
}
