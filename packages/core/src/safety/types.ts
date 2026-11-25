/**
 * D-005 hard-limit safety layer: shared types. Nothing here is configurable by
 * any setting (plan, preference, workspace, environment).
 */

/** Why a check blocks. Hard-limit codes count toward the workspace review flag. */
export type SafetyCode =
  /** Sexual content involving a minor or anyone who appears to be one. */
  | 'MINOR_SEXUAL'
  /** Sexual or intimate content depicting a real, identifiable person. */
  | 'REAL_PERSON_SEXUAL'
  /** Face/head swap or identity-driven model with an uploaded photo on a mature run. */
  | 'IDENTITY_SWAP_MATURE'
  /** Sexual content without consent (coercion, assault, hidden camera, "revenge" imagery). */
  | 'NON_CONSENSUAL'
  /** Realistic real-world extreme violence or gore imagery. */
  | 'EXTREME_VIOLENCE'
  /** Terrorism or violent-extremist propaganda. */
  | 'VIOLENT_EXTREMISM'
  /** Instructions for or encouragement of self-harm or suicide. */
  | 'SELF_HARM'
  /** Explicit content on a run without mature content enabled (not a violation). */
  | 'MATURE_REQUIRED'
  /** The classifier could not answer on a run that needs it (fail closed). */
  | 'SAFETY_UNAVAILABLE';

export const HARD_LIMIT_CODES: ReadonlySet<SafetyCode> = new Set<SafetyCode>([
  'MINOR_SEXUAL',
  'REAL_PERSON_SEXUAL',
  'NON_CONSENSUAL',
  'EXTREME_VIOLENCE',
  'VIOLENT_EXTREMISM',
  'SELF_HARM',
]);

export interface SafetyReason {
  code: SafetyCode;
  /** Internal detail for logs and review. Never shown to users. */
  detail: string;
}

export type CheckName = 'rules' | 'text' | 'vision' | 'faces';
export type CheckStatus = 'pass' | 'block' | 'error' | 'skipped';

export interface CheckRecord {
  name: CheckName;
  status: CheckStatus;
  /** Gateway model used, when any. */
  model?: string;
  /** Served from the verdict cache (no gateway call). */
  cached?: boolean;
  /** Gateway cost in USD when the provider reported it. */
  costUsd?: number;
  ms?: number;
  /** Error code or skip reason. */
  note?: string;
}

/** Content rating of a picture or clip (D-005 visibility uses this, not the run's mature flag). */
export type Rating = 'safe' | 'suggestive' | 'explicit';

export interface RatingResult {
  rating: Rating;
  /** 0..1, the classifier's confidence in the rating. */
  confidence: number;
  model: string;
}

export interface SafetyVerdict {
  verdict: 'allow' | 'block';
  reasons: SafetyReason[];
  checks: CheckRecord[];
  /** Media checks only: the highest rating seen; null when nothing could be rated. */
  rating?: RatingResult | null;
}

export type ReferenceSource = 'upload' | 'generated' | 'character' | 'public';

export interface SafetyReference {
  kind: 'image' | 'video' | 'audio' | 'text';
  source: ReferenceSource;
  /** https or `data:` URL the classifier can read (images). */
  url?: string;
  /** Text attached to the reference (asset name, caption). */
  caption?: string;
  /** Content hash (hex) for the verdict cache. */
  hash?: string;
}

/** The parts of a catalog model the checks need. */
export interface SafetyModel {
  id: string;
  requiresIdentitySafety?: boolean;
  operations?: readonly string[];
}

export interface PreCheckInput {
  prompt: string;
  negativePrompt?: string;
  references: SafetyReference[];
  mature: boolean;
  model?: SafetyModel | null;
}

export interface SafetyOutput {
  kind: 'image' | 'video';
  /** The image itself (https or data URL). Ignored for video. */
  url?: string;
  /** Video: sampled frames (first/middle/last or the provider thumbnail). */
  frames?: string[];
  hash?: string;
}

export interface PostCheckInput {
  outputs: SafetyOutput[];
  mature: boolean;
  prompt: string;
}

/** Stored verdict assessments by content hash (assessments, not verdicts: decisions depend on `mature`). */
export interface VerdictCache {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<void>;
}

/** One row of `safety_events` (no prompt beyond a 200-character excerpt, no media). */
export interface SafetyEvent {
  id: string;
  workspaceId: string;
  userId: string | null;
  runId: string | null;
  jobId: string | null;
  stage: 'pre' | 'post' | 'agent' | 'quote' | 'upload';
  verdict: 'allow' | 'block';
  codes: SafetyCode[];
  model: string | null;
  excerpt: string | null;
  createdAt: number;
}

/** Neutral user-facing copy for any block (codes and details stay internal). */
export const SAFETY_BLOCKED_MESSAGE = 'This can’t be generated under our content rules.';
export const MATURE_REQUIRED_MESSAGE = 'Turn on mature content in Settings to generate this, or change the prompt.';
export const MATURE_JOIN_MESSAGE = 'Join a plan and turn on mature content to generate this, or change the prompt.';
export const SAFETY_REVIEW_MESSAGE = 'Mature content is paused for this workspace while recent activity is reviewed.';

/** Workspace review flag: this many hard-limit blocks within the window. */
export const FLAG_THRESHOLD = 3;
export const FLAG_WINDOW_MS = 24 * 3600 * 1000;

export function excerptOf(text: string | undefined | null, max = 200): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}
