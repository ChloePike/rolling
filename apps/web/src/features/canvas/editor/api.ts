import { MOCK_CUT_TO_10, MOCK_SCRIPT, mockProject, type EditorProject, type EditProposal } from './mocks';
import { assembleFromScript } from './timeline/assemble';
import { planCutTo } from './timeline/plan';
import { edlDuration, type Edl } from './timeline/types';

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
