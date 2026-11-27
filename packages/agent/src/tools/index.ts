/**
 * Tool registry (docs/harness.md section 3). Read tools run here; propose
 * tools are validated in `../proposals.ts`. There is intentionally no run,
 * buy, delete-project or share tool.
 */
import type { ToolDefinition } from '@rolling/core';
import { planAllowsResolution, lowestPlanFor } from '@rolling/core/pricing/config';
import type { z } from 'zod/v4';
import type { AccountSnapshot, AgentPorts } from '../ports';
import { decodeJsonStrings } from '../proposals';
import type { Surface } from '../types';
import { canvasView, compactParams, timelineView } from './compact';
import {
  AssetsSearchInput,
  CanvasGetInput,
  EmptyInput,
  issueText,
  ModelsCapabilitiesInput,
  PricingEstimateInput,
  ProposeFieldsInput,
  ProposeGraphPatchInput,
  ProposePlanInput,
  ProposeTimelinePatchInput,
  ScriptGetInput,
  TemplatesSearchInput,
  TimelineGetInput,
  toToolParameters,
} from './schemas';

export interface ToolContext {
  ports: AgentPorts;
  account: AccountSnapshot;
  thread: { projectId: string | null; canvasId: string | null; surface: Surface };
}

export type ToolName =
  | 'canvas.get'
  | 'script.get'
  | 'assets.search'
  | 'characters.list'
  | 'voices.list'
  | 'models.capabilities'
  | 'pricing.estimate'
  | 'account.get'
  | 'templates.search'
  | 'timeline.get'
  | 'propose.plan'
  | 'propose.graphPatch'
  | 'propose.timelinePatch'
  | 'propose.fields';

export interface ToolSpec {
  name: ToolName;
  kind: 'read' | 'propose';
  description: string;
  input: z.ZodType;
  surfaces: readonly Surface[];
  run?: (input: never, ctx: ToolContext) => Promise<unknown>;
}

const ALL: readonly Surface[] = ['home', 'canvas', 'editor', 'tool'];
const PROJECT: readonly Surface[] = ['canvas', 'editor'];

function available(account: AccountSnapshot): number {
  return account.balance.plan + account.balance.purchased - account.balance.held;
}

async function modelsCapabilities(input: z.infer<typeof ModelsCapabilitiesInput>, ctx: ToolContext) {
  const { models } = ctx.ports;
  const plan = ctx.account.plan;
  const kind = input.kind === 'avatar' ? 'video' : input.kind;
  const list = models
    .models()
    .filter((m) => m.kind === kind && !m.hidden && (ctx.account.matureAllowed || !m.matureOnly))
    .filter((m) => (input.kind === 'avatar' ? m.lipSync || m.operations.includes('lip_sync') : m.placement !== 'tool' && !m.requiresIdentitySafety))
    .map((m) => {
      const allowed = m.resolutions.filter((r) => !plan || planAllowsResolution(plan, kind, r));
      const locked = m.resolutions.filter((r) => !allowed.includes(r)).map((r) => `${r} needs ${lowestPlanFor(kind, r) ?? 'n/a'}`);
      const credits: Record<string, number | null> = {};
      const sample = kind === 'video' ? { seconds: 5 } : {};
      for (const r of allowed.length ? allowed : [undefined]) {
        credits[r ?? 'default'] = models.creditsFor(m, r ? { ...sample, resolution: r } : sample);
      }
      return {
        id: m.id,
        name: m.displayName,
        modes: m.operations,
        ...(m.seconds ? { seconds: m.seconds.allowed ?? `${m.seconds.min}-${m.seconds.max}` } : {}),
        ...(m.defaultResolution ? { defaultResolution: m.defaultResolution } : {}),
        resolutions: allowed,
        ...(locked.length ? { locked } : {}),
        ...(m.ratios.length ? { ratios: m.ratios.filter((r) => ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(r)) } : {}),
        audio: m.audio,
        ...(m.maxReferenceImages ? { refImages: m.maxReferenceImages } : {}),
        [kind === 'video' ? 'creditsPer5s' : 'creditsPerImage']: credits,
        ...(m.default ? { default: true } : {}),
        ...(m.placement === 'featured' ? {} : { more: true }),
        ...(m.tags.length ? { tags: m.tags } : {}),
      };
    })
    .sort((a, b) => Number(!!a.more) - Number(!!b.more));
  return { kind: input.kind, plan, models: list };
}

async function pricingEstimate(input: z.infer<typeof PricingEstimateInput>, ctx: ToolContext) {
  const { models } = ctx.ports;
  const items = input.items.map((item) => {
    const model = models.get(item.model);
    if (!model) return { model: item.model, error: 'unknown model' };
    const kind = item.kind === 'avatar' ? 'video' : item.kind;
    if (item.resolution && ctx.account.plan && model.resolutions.length && !planAllowsResolution(ctx.account.plan, kind, item.resolution)) {
      return { model: item.model, error: `${item.resolution} needs the ${lowestPlanFor(kind, item.resolution)} plan` };
    }
    const credits = models.creditsFor(model, {
      ...(kind === 'video' ? { seconds: item.seconds ?? model.defaultSeconds ?? 5 } : {}),
      ...(item.resolution ? { resolution: item.resolution } : {}),
      ...(item.count ? { n: item.count } : {}),
    });
    return credits === null ? { model: item.model, error: 'cannot be priced with these settings' } : { model: item.model, credits };
  });
  const total = items.reduce((s, i) => s + ('credits' in i && typeof i.credits === 'number' ? i.credits : 0), 0);
  const balance = available(ctx.account);
  return { items, total, balance, balanceAfter: balance - total, needsConfirm: total > ctx.account.confirmThreshold };
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'canvas.get',
    kind: 'read',
    description:
      'Read the canvas before a graph patch: nodes (id, kind, title, params including shot and prompt, version, status, cost), edges with their ids, and the revision to pass as baseRevision. Pass nodeIds to get only those nodes in full.',
    input: CanvasGetInput,
    surfaces: PROJECT,
    run: async (input: z.infer<typeof CanvasGetInput>, ctx: ToolContext) => {
      const graph = await ctx.ports.canvas.getGraph(input.projectId);
      if (!graph) return { error: 'project not found' };
      return canvasView(graph.state, graph.assets, input.nodeIds);
    },
  },
  {
    name: 'script.get',
    kind: 'read',
    description: 'Rows of one script node (shot number, title, visual, line, seconds). Use it when the user refers to the script; canvas.get already lists the script node.',
    input: ScriptGetInput,
    surfaces: PROJECT,
    run: async (input: z.infer<typeof ScriptGetInput>, ctx: ToolContext) => {
      if (!ctx.thread.projectId) return { error: 'no project in this thread' };
      const graph = await ctx.ports.canvas.getGraph(ctx.thread.projectId);
      const node = graph?.state.nodes.find((n) => n.id === input.nodeId);
      if (!node) return { error: 'node not found' };
      if (node.kind !== 'script') return { error: `node is a ${node.kind} node, not a script` };
      return { nodeId: node.id, title: node.title, ...compactParams(node.params, 2000) };
    },
  },
  {
    name: 'assets.search',
    kind: 'read',
    description:
      'Find pictures, clips or audio by words: the user\'s uploads, team files, built-in items and the public library (poses, outfits, scenes). Returns up to 12 items with id, name, kind, source and license. Use it only when the user asks for an existing asset; `@` references are already resolved in the context.',
    input: AssetsSearchInput,
    surfaces: ALL,
    run: async (input: z.infer<typeof AssetsSearchInput>, ctx: ToolContext) => ({
      items: await ctx.ports.assets.search({ query: input.query, scope: input.scope, ...(input.kind ? { kind: input.kind } : {}), limit: 12 }),
    }),
  },
  {
    name: 'characters.list',
    kind: 'read',
    description: 'Saved characters of the workspace (id, name, kind, look, wardrobe, outfit variants, whether a sheet exists). Call it when the brief names a character, asks for "my character", or has a recurring person. Use the saved name in characters: the server links it, repeats its locked look and passes its sheet pictures to every shot. Name an outfit variant in wardrobe to dress the character in it.',
    input: EmptyInput,
    surfaces: ALL,
    // Sheet picture ids stay server side: the plan wires them into the shots (D-032).
    run: async (_input: unknown, ctx: ToolContext) => ({
      items: (await ctx.ports.assets.characters()).map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.description && { description: c.description }),
        ...(c.kind && { kind: c.kind }),
        ...(c.look && { look: c.look }),
        ...(c.wardrobe && { wardrobe: c.wardrobe }),
        ...(c.sheet && { hasSheet: Object.keys(c.sheet).length > 0 }),
        ...(c.outfits?.length && { outfits: c.outfits.map((o) => o.name) }),
      })),
    }),
  },
  {
    name: 'voices.list',
    kind: 'read',
    description: 'Saved voices of the workspace (id, name, description), for the avatar form.',
    input: EmptyInput,
    surfaces: ALL,
    run: async (_input: unknown, ctx: ToolContext) => ({ items: await ctx.ports.assets.voices() }),
  },
  {
    name: 'models.capabilities',
    kind: 'read',
    description:
      'Models the user can use for a kind, default first: id (use it exactly), modes, seconds range (whole seconds), resolutions this plan allows, ratios, audio (true = it can voice dialogue and sound), and creditsPer5s or creditsPerImage per resolution for comparing cost. The context already lists the video models on Home; call this for image or avatar models, for ratios or modes, or before choosing a model for a new canvas node.',
    input: ModelsCapabilitiesInput,
    surfaces: ALL,
    run: modelsCapabilities as ToolSpec['run'],
  },
  {
    name: 'pricing.estimate',
    kind: 'read',
    description:
      'Credits for runs you describe (model, kind, seconds, resolution, count), with the total and the balance after. Not needed for plans or graph patches: the server prices those. Use it when the user asks what something would cost.',
    input: PricingEstimateInput,
    surfaces: ALL,
    run: pricingEstimate as ToolSpec['run'],
  },
  {
    name: 'account.get',
    kind: 'read',
    description: 'Plan, credit balance (plan, purchased, held, available), confirm threshold, creation mode and language. The same snapshot is already in the context; call it only after the user says the balance changed.',
    input: EmptyInput,
    surfaces: ALL,
    run: async (_input: unknown, ctx: ToolContext) => accountView(ctx.account),
  },
  {
    name: 'templates.search',
    kind: 'read',
    description: 'Built-in templates matching a few words, with the slots the user fills (product photo, logo, tagline). Use it when the user asks for a template.',
    input: TemplatesSearchInput,
    surfaces: ['home', 'canvas'],
    run: async (input: z.infer<typeof TemplatesSearchInput>, ctx: ToolContext) => ({ items: await ctx.ports.templates.search(input.query, 8) }),
  },
  {
    name: 'timeline.get',
    kind: 'read',
    description: 'Read the timeline before a timeline patch: tracks, clips with ids, start and end times, gaps, total duration, and the revision to pass as baseRevision.',
    input: TimelineGetInput,
    surfaces: ['editor'],
    run: async (input: z.infer<typeof TimelineGetInput>, ctx: ToolContext) => {
      const t = await ctx.ports.timeline.get(input.canvasId);
      return t ? timelineView(t.revision, t.edl) : { error: 'no timeline for this canvas' };
    },
  },
  {
    name: 'propose.plan',
    kind: 'propose',
    description:
      'Propose 2-3 plan options for a brief. An option has a ratio, a video model, an optional look and characters shared by its shots, and shots made of fields (subject, action, setting, camera, lighting, cast, dialogue, sound, line) with whole seconds. The server writes each model\'s prompt from the fields, checks lengths, pacing, cast and the prompt box settings, prices every option and builds the nodes. An error names what to fix. Building nodes from a plan is free.',
    input: ProposePlanInput,
    surfaces: ['home', 'canvas'],
  },
  {
    name: 'propose.graphPatch',
    kind: 'propose',
    description:
      'Propose canvas changes as GraphOps against the revision canvas.get returned. Change a planned shot through params.shot with only the fields that change; the server merges them, rewrites the prompt and prices the nodes that need a new run. Applying is free; running changed nodes costs credits later.',
    input: ProposeGraphPatchInput,
    surfaces: ['canvas'],
  },
  {
    name: 'propose.timelinePatch',
    kind: 'propose',
    description: 'Propose timeline edits (trim, move, split, remove, gain, captions, speed, fades, dissolves) as TimelineOps against the revision timeline.get returned. The result may not overlap clips on a track. Free: nothing is regenerated.',
    input: ProposeTimelinePatchInput,
    surfaces: ['editor'],
  },
  {
    name: 'propose.fields',
    kind: 'propose',
    description:
      'Fill a Simple-mode tool form from free text. quick: {kind, prompt, model?, seconds?, ratio?, resolution?, audio?, count?}; remix: {sourceAssetId?, prompt, keep?, model?, strength?}; avatar: {script, look?, characterId?, voiceId?, background?, ratio?}; character: {name, look, outfit?, personality?, style?}.',
    input: ProposeFieldsInput,
    surfaces: ['tool'],
  },
];

export function accountView(a: AccountSnapshot) {
  return {
    plan: a.plan,
    balance: { ...a.balance, available: available(a) },
    confirmThreshold: a.confirmThreshold,
    creationMode: a.creationMode,
    language: a.language,
    // D-005: whether this member may plan adult content. The safety gate decides; this tells the model which way to answer.
    matureContent: a.matureAllowed ? 'on' : 'off',
  };
}

/**
 * The video models as a few lines of context, default first, so a plan needs
 * no `models.capabilities` call (one LLM call less per plan turn): id, whole
 * seconds range, whether it makes sound, credits per 5 s per allowed resolution.
 */
export async function videoModelsSection(ctx: ToolContext): Promise<string> {
  const { models } = await modelsCapabilities({ kind: 'video' }, ctx);
  const lines = [...models]
    .sort((a, b) => Number(!!b.default) - Number(!!a.default))
    .map((m) => {
      const credits = Object.entries((m as unknown as { creditsPer5s?: Record<string, number | null> }).creditsPer5s ?? {})
        .filter(([, c]) => c !== null)
        .map(([r, c]) => `${r} ${c}`)
        .join(', ');
      const notes = [m.default ? 'default' : '', m.audio ? 'audio' : 'silent', m.modes.includes('i2v') ? '' : 'text-to-video only', m.defaultResolution ? `default resolution ${m.defaultResolution}` : ''].filter(Boolean).join(', ');
      return `${m.id} | ${Array.isArray(m.seconds) ? `${m.seconds.join(' or ')} s` : `${m.seconds ?? '?'} s`} | ${notes} | credits per 5 s: ${credits}`;
    });
  return `# Video models\nid | whole seconds per shot | notes | cost\n${lines.join('\n')}`;
}

export function toolsFor(surface: Surface): ToolSpec[] {
  return TOOLS.filter((t) => t.surfaces.includes(surface));
}

export function getTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

const definitionCache = new Map<string, ToolDefinition>();

export function toolDefinition(tool: ToolSpec): ToolDefinition {
  let def = definitionCache.get(tool.name);
  if (!def) {
    def = { name: tool.name, description: tool.description, parameters: toToolParameters(tool.input) };
    definitionCache.set(tool.name, def);
  }
  return def;
}

/** Runs a read tool. Bad input and failures come back as `{ error }` for the model. */
export async function runReadTool(tool: ToolSpec, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = tool.input.safeParse(decodeJsonStrings(rawArgs ?? {}));
  if (!parsed.success) return { error: `invalid input: ${issueText(parsed.error)}` };
  try {
    return await tool.run!(parsed.data as never, ctx);
  } catch (err) {
    return { error: `tool failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
