/**
 * Context assembly per turn (docs/harness.md section 4), budgeted to ~24k
 * tokens with the cheap estimator in `./tokens`.
 */
import type { ChatMessage, ToolDefinition } from '@rolling/core';
import type { GraphState } from '@rolling/core/graph';
import { SKILL_PROMPTS, SYSTEM_PROMPT } from './prompts.generated';
import type { AccountSnapshot, AgentPorts, AssetItem } from './ports';
import { accountView, videoModelsSection } from './tools';
import { canvasView, compactNode, compactParams, nodeLine, timelineView } from './tools/compact';
import { estimateTokens, estimateValueTokens, truncateToTokens } from './tokens';
import type { FieldTool } from './tools/schemas';
import type { Proposal, Surface, ThreadMessage } from './types';

export const CONTEXT_BUDGET = 24_000;
/** Kept free inside the budget for tool results and the reply within the turn. */
export const TURN_HEADROOM = 4_000;
export const VERBATIM_MESSAGES = 12;
export const SUMMARY_EVERY_TURNS = 10;

export interface ThreadState {
  threadId: string;
  surface: Surface;
  skill: string | null;
  projectId: string | null;
  canvasId: string | null;
  /** Summary of messages older than the verbatim window. */
  summary: string;
  /** Stored messages, oldest first (the builder keeps the last 12). */
  messages: ThreadMessage[];
  /** Proposals of this thread (for notes on stored messages and stale notices). */
  proposals: Proposal[];
  brandKit?: string | null;
  /** Tool surface: which Simple-mode form this thread fills. */
  tool?: FieldTool | null;
}

export interface TurnInput {
  text: string;
  /** `@` asset ids. */
  refs: string[];
  /** Selected node ids (canvas). */
  selection: string[];
  /** What the prompt box's pills say (Home: video model, aspect ratio, length); used unless the brief says otherwise. */
  settings?: TurnSettings;
}

export interface TurnSettings {
  /** Catalog video model id, or null for Auto (the default model). */
  videoModel?: string | null;
  ratio?: string;
  /** Total length in seconds. */
  seconds?: number;
  /** Video resolution, e.g. 720p. */
  resolution?: string;
}

/** The prompt box settings as one context line; null when there are none. */
export function settingsSection(s: TurnSettings | undefined): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.ratio) parts.push(`aspect ratio ${s.ratio}`);
  if (s.seconds) parts.push(`total length ${s.seconds} s`);
  if (s.resolution) parts.push(`resolution ${s.resolution}`);
  if (s.videoModel !== undefined) parts.push(s.videoModel ? `video model ${s.videoModel}` : 'video model Auto (the default one)');
  if (!parts.length) return null;
  return `# Prompt box settings\nThe user picked ${parts.join(', ')} on the prompt box. Every plan option uses these unless the brief itself names a different one; the server checks.`;
}

/** Which surfaces a section of the system prompt (by its `# ` heading) is for; unlisted sections (role, reply, when not to plan, how to work) go everywhere. */
const SECTION_SURFACES: Record<string, readonly Surface[]> = {
  'Shots are fields, not prose': ['home', 'canvas'],
  Continuity: ['home', 'canvas'],
  'Plans (`propose.plan`)': ['home', 'canvas'],
  'Graph patches (`propose.graphPatch`)': ['canvas'],
  'Timeline patches (`propose.timelinePatch`)': ['editor'],
  'Tool forms (`propose.fields`)': ['tool'],
};

const promptCache = new Map<Surface, string>();

/** The system prompt without the sections for tools this surface does not have. */
export function systemPromptFor(surface: Surface): string {
  let out = promptCache.get(surface);
  if (out === undefined) {
    out = SYSTEM_PROMPT.split(/^(?=# )/m)
      .filter((section) => {
        const heading = /^# (.+)$/m.exec(section)?.[1]?.trim() ?? '';
        const surfaces = SECTION_SURFACES[heading];
        return !surfaces || surfaces.includes(surface);
      })
      .join('')
      .trim();
    promptCache.set(surface, out);
  }
  return out;
}

export interface BuiltContext {
  messages: ChatMessage[];
  /** Estimated prompt tokens including tool definitions. */
  tokens: number;
  /** Stored messages included verbatim. */
  historyCount: number;
  refs: AssetItem[];
  revision: number | null;
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function proposalNote(p: Proposal): string {
  const cost = p.estimate.credits ? `, runs would cost ${p.estimate.credits} credits` : ', free';
  return `[proposal ${p.id} (${p.kind}), ${p.status}${cost}: ${p.summary}]`;
}

/** Workspace section: selection in full, the rest one line per node, script, refs, brand kit. */
export function workspaceSection(
  thread: ThreadState,
  input: TurnInput,
  graph: { state: GraphState; assets: Record<string, string> } | null,
  timeline: { revision: number; edl: Parameters<typeof timelineView>[1] } | null,
  refs: readonly AssetItem[],
  maxTokens: number,
): string {
  const parts: string[] = [`Surface: ${thread.surface}.`];
  if (thread.tool) parts.push(`Tool: ${thread.tool}. Fill its form with propose.fields (tool "${thread.tool}").`);
  if (thread.projectId) parts.push(`Project: ${thread.projectId}.`);
  if (graph) {
    const sel = new Set(input.selection);
    const selected = graph.state.nodes.filter((n) => sel.has(n.id));
    const rest = graph.state.nodes.filter((n) => !sel.has(n.id));
    parts.push(`Canvas revision: ${graph.state.revision}. ${graph.state.nodes.length} nodes, ${graph.state.edges.length} edges.`);
    if (selected.length) parts.push(`Selected nodes:\n${selected.map((n) => JSON.stringify(compactNode(n, graph.assets))).join('\n')}`);
    if (rest.length) parts.push(`Other nodes:\n${rest.map(nodeLine).join('\n')}`);
    if (graph.state.edges.length) {
      parts.push(`Edges:\n${canvasView(graph.state, {}).edges.map((e) => `${String(e.id)} ${String(e.from)} -> ${String(e.to)}`).join('\n')}`);
    }
    const script = graph.state.nodes.find((n) => n.kind === 'script');
    if (script && !sel.has(script.id)) parts.push(`Script ${script.id}: ${JSON.stringify(compactParams(script.params, 300))}`);
  }
  if (thread.canvasId) parts.push(`Canvas id: ${thread.canvasId}.`);
  if (timeline) parts.push(`Timeline: ${JSON.stringify(timelineView(timeline.revision, timeline.edl))}`);
  if (refs.length) {
    parts.push(`Referenced with @:\n${refs.map((r) => `${r.id} ${r.kind} "${r.name}" (${r.source}${r.description ? `: ${r.description.slice(0, 160)}` : ''})`).join('\n')}`);
  }
  const missing = input.refs.filter((id) => !refs.some((r) => r.id === id));
  if (missing.length) parts.push(`References that could not be found: ${missing.join(', ')}.`);
  if (thread.brandKit) parts.push(`Brand kit: ${thread.brandKit}`);
  const stale = thread.proposals.filter((p) => p.status === 'stale');
  if (stale.length) parts.push(`Stale proposals (the canvas changed, they no longer apply): ${stale.slice(-3).map((p) => p.id).join(', ')}.`);
  return truncateToTokens(parts.join('\n\n'), maxTokens);
}

export async function buildContext(args: {
  thread: ThreadState;
  input: TurnInput;
  account: AccountSnapshot;
  ports: AgentPorts;
  tools: ToolDefinition[];
  budget?: number;
}): Promise<BuiltContext> {
  const { thread, input, account, ports } = args;
  const budget = (args.budget ?? CONTEXT_BUDGET) - TURN_HEADROOM - estimateValueTokens(args.tools);

  const [graph, timeline, refs] = await Promise.all([
    thread.projectId && thread.surface !== 'home' ? ports.canvas.getGraph(thread.projectId) : Promise.resolve(null),
    thread.canvasId && thread.surface === 'editor' ? ports.timeline.get(thread.canvasId) : Promise.resolve(null),
    input.refs.length ? ports.assets.resolve(input.refs) : Promise.resolve([] as AssetItem[]),
  ]);

  const skill = thread.skill ? SKILL_PROMPTS[thread.skill] : undefined;
  const accountText = `# Account\n${JSON.stringify(accountView(account))}\nReply language: ${languageName(account.language)}.`;
  // Home plans choose video models every time: listing them here saves the models.capabilities round trip.
  const modelsText = thread.surface === 'home' ? await videoModelsSection({ ports, account, thread: { projectId: thread.projectId, canvasId: thread.canvasId, surface: thread.surface } }) : '';
  const fixed = [systemPromptFor(thread.surface), skill ? `# Active skill\n${skill}` : '', accountText, modelsText, settingsSection(input.settings) ?? ''].filter(Boolean).join('\n\n');
  let used = estimateTokens(fixed);

  const userText = truncateToTokens(input.text, 4_000);
  used += estimateTokens(userText);

  const workspace = `# Workspace\n${workspaceSection(thread, input, graph, timeline, refs, Math.max(1_000, Math.floor((budget - used) * 0.5)))}`;
  used += estimateTokens(workspace);

  const summary = thread.summary ? `# Earlier in this thread\n${truncateToTokens(thread.summary, 1_500)}` : '';
  used += estimateTokens(summary);

  const byId = new Map(thread.proposals.map((p) => [p.id, p]));
  const recent = thread.messages.slice(-VERBATIM_MESSAGES);
  const history: ChatMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    const p = m.proposalId ? byId.get(m.proposalId) : undefined;
    const content = truncateToTokens(p ? `${m.content}\n${proposalNote(p)}` : m.content, 2_000);
    const cost = estimateTokens(content) + 4;
    if (used + cost > budget) break;
    used += cost;
    history.unshift(m.role === 'user' ? { role: 'user', content } : { role: 'assistant', content });
  }

  const system = [fixed, workspace, summary].filter(Boolean).join('\n\n');
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];
  return {
    messages,
    tokens: used + estimateValueTokens(args.tools),
    historyCount: history.length,
    refs,
    revision: graph?.state.revision ?? timeline?.revision ?? null,
  };
}
