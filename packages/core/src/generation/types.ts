/**
 * Run planning types (M4). A run plan lists one item per node in scope with
 * what a run would do to it (docs/architecture.md §6, D-005, D-006, D-009):
 *
 * - `run`: generate a new version (charged).
 * - `reuse`: the active version is valid (same input digest); nothing to do.
 * - `blocked`: cannot run now (missing input, plan cap, capability, ...), with a reason.
 * - `none`: nothing to generate (text, script, asset, audio, render nodes).
 * - `bypassed`: the node is switched off (`params.bypassed`); dependents use its
 *   pass-through input of the same type, or are blocked.
 */
import type { PriceRequest } from '../models/catalog';
import type { PromptExpansion } from '../models/expand';
import type { GenerationMode, ImageSource } from '../models/types';
import type { PlanId } from '../pricing/config';
import type { MatureAccess } from '../safety/types';
import type { ShotSpec } from '../prompting/shot';

export type RunScope = 'node' | 'selection' | 'all' | 'upTo' | 'from';
export type PlanAction = 'run' | 'reuse' | 'blocked' | 'none' | 'bypassed';

export type BlockCode =
  | 'missing_input'
  | 'upstream_blocked'
  | 'bypassed_input'
  | 'unknown_model'
  | 'no_capable_model'
  | 'unsupported'
  | 'unpriced'
  | 'resolution_locked'
  | 'mature_not_allowed'
  | 'identity_requires_platform_assets'
  /** D-037: a mature lip-sync with an uploaded voice (possibly a real person's). */
  | 'mature_voice'
  | 'empty_prompt';

/** Where one generation input comes from. Upstream node outputs resolve to their active asset when the job starts. */
export type InputSource =
  | { node: string }
  /**
   * `poster`: the video asset's poster frame (its thumbnail) as a picture.
   * `frameAt`: the video's frame at that second as a picture (extracted by the
   * FFmpeg container in `prepare`; falls back to the poster when `poster` is
   * set). `optional`: dropped from the request when no picture can be made.
   */
  | { assetId: string; origin: ImageSource; poster?: true; frameAt?: number; optional?: true }
  /** The output of another item of the same run (tool specs, e.g. a character's face from its full-body picture). */
  | { item: string }
  | { text: string };

export type InputRole = 'prompt' | 'frame' | 'reference' | 'edit' | 'audio';

export interface GenInput {
  role: InputRole;
  media: 'text' | 'image' | 'video' | 'audio';
  from: InputSource;
  /** What the input is, as the user sees it (the upstream node's title). Composed prompts bind references by it. */
  label?: string;
}

/**
 * D-005 mature text-to-video chain: no text-to-video model takes mature runs,
 * so the item is made in two steps of one run. `keyframe`: a mature-capable
 * text-to-image model draws the first frame at the video's ratio; `animate`:
 * a mature image-to-video model (the spicy family, platform pictures only)
 * animates it. `with` is the other step's item ref.
 */
export interface ChainStep {
  step: 'keyframe' | 'animate';
  with: string;
}

export type ChainStepName = ChainStep['step'];

/** Everything a job needs to build its provider request, frozen at quote time. */
export interface GenSpec {
  kind: 'image' | 'video';
  mode: GenerationMode;
  modelId: string;
  /** Chosen by Auto (D-009). */
  auto: boolean;
  /** Fallback models under the same hold, cheapest first: Auto's other candidates, or same-family siblings of an explicitly chosen model. */
  fallbacks: string[];
  prompt: string;
  /**
   * The structured shot `prompt` was composed from (agent-planned nodes whose
   * prompt the user has not edited). The provider prompt is composed from it
   * for the model that runs the job (`core/prompting`); `prompt` stays the
   * neutral text the safety checks and the UI read. Absent = `prompt` is the
   * user's own text and is sent as typed.
   */
  shot?: ShotSpec;
  negativePrompt?: string;
  seed?: number;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  n?: number;
  /** D-005 mature run: routed with `moderation: "low"`. */
  mature: boolean;
  /**
   * D-005 access of the caller at quote time (snapshot). `allowed`: content the
   * pre-check finds explicit re-plans the item as a mature run in `prepare`
   * instead of failing; otherwise it decides the MATURE_REQUIRED copy.
   */
  matureAccess?: MatureAccess;
  /** The run became mature because the prompt is explicit (not by the user's toggle). */
  matureAuto?: true;
  /** Media inputs (frames, references, edit inputs, audio), resolved to signed URLs in `prepare`. */
  inputs: GenInput[];
  /** Total length of the reference videos in ms, when known (priced by models that meter input video). */
  inputVideoMs?: number;
  /**
   * Lengths (seconds, by asset id) this item was quoted with that came from the
   * browser at upload, before probing. `prepare` re-checks them against the
   * probed length and fails (refunded) when the file is clearly longer.
   */
  declaredDurations?: Record<string, number>;
  /** Step of a mature text-to-video chain (D-005): the keyframe is held together with the animation and settled on its own. */
  chain?: ChainStep;
  /**
   * "Enhance prompt" (D-020): the user asked the gateway to rewrite the prompt
   * before the render. Sent and priced only on models that take `prompt_expand`
   * (an Auto fallback without it renders the prompt as written).
   */
  promptExpand?: PromptExpansion;
}

export interface PlanItem {
  /** Node id; `spec` for a tool page prompt spec. */
  ref: string;
  nodeId: string | null;
  title: string;
  kind: string;
  action: PlanAction;
  code?: BlockCode;
  /** Human-readable English reason (the UI maps `code` to copy). */
  reason?: string;
  /** For `resolution_locked`: the lowest plan that allows it. */
  lowestPlan?: PlanId | null;
  /** For `MATURE_REQUIRED`: the caller's D-005 access (the copy, and `no_plan` opens the upgrade modal with reason `mature`). */
  matureAccess?: MatureAccess;
  /** Catalog model id (run/reuse rows) or null. */
  model: string | null;
  modelName: string | null;
  /** How Auto chose (run rows with model Auto). */
  autoVia?: 'classifier' | 'fallback' | 'single';
  /** Node ids of run items this one waits for (their outputs are inputs here). */
  dependsOn: string[];
  /** Current input digest of the node (graph runs). */
  digest?: string;
  /** Hash of the node params at quote time (detects edits before the job starts). */
  paramsHash?: string;
  spec?: GenSpec;
  priceRequest?: PriceRequest;
}

export interface RunPlan {
  items: PlanItem[];
}

/** Planning context from the auth context and catalog. */
export interface PlanContext {
  /** Workspace plan, null for non-members (they can quote, not run; D-007). */
  plan: PlanId | null;
  /** D-005: member, preference on, workspace allows. */
  matureAllowed: boolean;
  /** D-005: why mature content is not allowed (MATURE_REQUIRED copy); derived from `matureAllowed` when absent. */
  matureAccess?: MatureAccess;
  /**
   * "Enhance prompt" (D-020). `default`: the user's preference, used when an
   * item does not say (agent-planned canvas nodes default to off instead);
   * `available`: false while the gateway refuses the feature for this
   * environment (nothing is expanded or priced); `locale`: unused, the locale
   * follows the prompt (`promptLocale`, D-020). Absent = no expansion.
   */
  promptExpand?: { default: boolean; available: boolean; locale?: string };
}

/** Active version of a node: the version id and the digest it was made with. */
export interface ActiveVersion {
  versionId: string;
  digest: string;
  assetId: string | null;
}
