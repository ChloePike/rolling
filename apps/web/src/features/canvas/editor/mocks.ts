import { MUSIC_PEAKS_TENTHS, VOICE_PEAKS_TENTHS } from './mockPeaks';
import { assembleFromScript, type AssembleInput } from './timeline/assemble';
import type { Highlight } from './timeline/plan';
import type { Edl, TimelineOp } from './timeline/types';

/**
 * Mock data for the editor, shaped like the ProjectRoom snapshot (EDL +
 * media catalog) and the agent's `proposal.created` payload. Matches the
 * Ridgeline Sparkling project in CanvasEdit.dc.html / CanvasEditAgent.dc.html.
 */

export interface ShotInfo {
  nodeId: string;
  title: string;
  model: string;
  resolution: string;
  /** Generated length in seconds. */
  seconds: number;
  /** Credits to generate or regenerate this shot. */
  credits: number;
}

export interface AudioInfo {
  assetId: string;
  title: string;
  seconds: number;
  /** Half-heights in tenths of a pixel, `PEAKS_PER_SECOND` per second; repeats when shorter than the media. */
  peaks: readonly number[];
}

export type BinKind = 'video' | 'voice' | 'music' | 'image';

export interface BinItem {
  id: string;
  kind: BinKind;
  title: string;
  /** Seconds, or null for images. */
  seconds: number | null;
  notGenerated?: boolean;
  /** Thumbnail tint. */
  color: string;
  nodeId?: string;
  assetId?: string;
}

export interface EditProposal {
  id: string;
  request: string;
  title: string;
  bullets: string[];
  /** Cost line from the agent. Edits that need no generation are free. */
  note: string;
  credits: number;
  ops: TimelineOp[];
  highlights: Highlight[];
}

export interface EditorProject {
  id: string;
  title: string;
  /** Name of the script version the cut was assembled from. */
  scriptName: string;
  edl: Edl;
  /** Mark in / mark out (export range), seconds. */
  marks: { in: number; out: number };
  shots: Record<string, ShotInfo>;
  audio: Record<string, AudioInfo>;
  bin: BinItem[];
  /** Playable URLs by asset id. The mock has none, so the monitor shows placeholders. */
  mediaUrls?: Record<string, string>;
  /** Where the editor opens: playhead and selected clip. */
  view: { playhead: number; selection: string | null };
}

export const MOCK_SCRIPT: AssembleInput = {
  fps: 24,
  width: 1080,
  height: 1920,
  shots: [
    { nodeId: 'node_shot_a', assetId: 'ast_shot_a', seconds: 4, caption: { text: 'Morning. The first sip of the mountains.', at: 0.4 } },
    { nodeId: 'node_shot_b', assetId: 'ast_shot_b', seconds: 5, caption: { text: 'Pop it open.', at: 0.6, dur: 2 } },
    { nodeId: 'node_shot_c', assetId: null, seconds: 3 },
  ],
  voiceover: { assetId: 'ast_voiceover', seconds: 8, at: 0.4 },
  music: { assetId: 'ast_music_morning', seconds: 10, gainDb: -6 },
  shotGainDb: -6,
};

export const MOCK_SHOTS: Record<string, ShotInfo> = {
  node_shot_a: { nodeId: 'node_shot_a', title: 'Shot A, hero', model: 'Seedance 2.5', resolution: '1080p', seconds: 4, credits: 8 },
  node_shot_b: { nodeId: 'node_shot_b', title: 'Shot B, cap pop', model: 'Seedance 2.5', resolution: '1080p', seconds: 5, credits: 8 },
  node_shot_c: { nodeId: 'node_shot_c', title: 'Shot C, logo', model: 'Seedance 2.5', resolution: '1080p', seconds: 3, credits: 8 },
};

export const MOCK_AUDIO: Record<string, AudioInfo> = {
  ast_voiceover: { assetId: 'ast_voiceover', title: 'Voiceover', seconds: 8, peaks: VOICE_PEAKS_TENTHS },
  ast_music_morning: { assetId: 'ast_music_morning', title: 'Music, morning', seconds: 30, peaks: MUSIC_PEAKS_TENTHS },
};

export const MOCK_BIN: BinItem[] = [
  { id: 'bin_shot_a', kind: 'video', title: 'Shot A, hero', seconds: 4, color: '#2B3550', nodeId: 'node_shot_a', assetId: 'ast_shot_a' },
  { id: 'bin_shot_b', kind: 'video', title: 'Shot B, cap pop', seconds: 5, color: '#243A40', nodeId: 'node_shot_b', assetId: 'ast_shot_b' },
  { id: 'bin_shot_c', kind: 'video', title: 'Shot C, logo', seconds: 3, notGenerated: true, color: '#1C1C1F', nodeId: 'node_shot_c' },
  { id: 'bin_voiceover', kind: 'voice', title: 'Voiceover', seconds: 8, color: '#1F3A2C', assetId: 'ast_voiceover' },
  { id: 'bin_music', kind: 'music', title: 'Music, morning', seconds: 30, color: '#3A3224', assetId: 'ast_music_morning' },
  { id: 'bin_keyframe', kind: 'image', title: 'Product keyframe', seconds: null, color: '#2E2A3A', assetId: 'ast_keyframe' },
];

export function mockProject(projectId: string): EditorProject {
  return {
    id: projectId,
    title: 'Ridgeline Sparkling',
    scriptName: 'Script v2',
    edl: assembleFromScript(MOCK_SCRIPT),
    marks: { in: 0, out: 9 },
    shots: MOCK_SHOTS,
    audio: MOCK_AUDIO,
    bin: MOCK_BIN,
    view: { playhead: 2.6, selection: 'v1' },
  };
}

/** The agent's answer to “cut to 10s” on the mock project (CanvasEditAgent.dc.html). */
export const MOCK_CUT_TO_10: Omit<EditProposal, 'id' | 'request'> = {
  title: 'Trim 2 seconds, no regeneration needed',
  bullets: ['Shot B ends 1s earlier, on the bubbles', 'Shot C becomes 2s, logo holds longer', 'Voiceover and captions shift to match'],
  note: 'Free. Trimmed parts stay recoverable.',
  credits: 0,
  ops: [
    { op: 'trim', clipId: 'v2', out: 4 },
    { op: 'move', clipId: 'v3', start: 8 },
    { op: 'trim', clipId: 'v3', out: 2 },
  ],
  highlights: [{ clipId: 'v2', from: 8, to: 9, kind: 'remove' }],
};
