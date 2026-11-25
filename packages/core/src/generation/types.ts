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
import type { GenerationMode, ImageSource } from '../models/types';
import type { PlanId } from '../pricing/config';

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
  | 'empty_prompt';

/** Where one generation input comes from. Upstream node outputs resolve to their active asset when the job starts. */
export type InputSource =
  | { node: string }
  /** `poster`: the video asset's poster frame (its thumbnail) as a picture. */
  | { assetId: string; origin: ImageSource; poster?: true }
  /** The output of another item of the same run (tool specs, e.g. a character's face from its full-body picture). */
  | { item: string }
  | { text: string };

export type InputRole = 'prompt' | 'frame' | 'reference' | 'edit' | 'audio';

export interface GenInput {
  role: InputRole;
  media: 'text' | 'image' | 'video' | 'audio';
  from: InputSource;
}

/** Everything a job needs to build its provider request, frozen at quote time. */
export interface GenSpec {
  kind: 'image' | 'video';
  mode: GenerationMode;
  modelId: string;
  /** Chosen by Auto (D-009). */
  auto: boolean;
  /** Next models for the one Auto retry under the same hold, cheapest first. */
  fallbacks: string[];
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  n?: number;
  /** D-005 mature run: routed with `moderation: "low"`. */
  mature: boolean;
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
}

/** Active version of a node: the version id and the digest it was made with. */
export interface ActiveVersion {
  versionId: string;
  digest: string;
  assetId: string | null;
}
