/** Shared types for the overlay components. Shapes follow docs/api.md where a response exists. */

/** Which catalog a model picker shows. */
export type ModelKind = 'video' | 'image' | 'avatar';

/** Value of the Auto option in the model picker. */
export const AUTO_MODEL = 'auto';

export type ModelBadge = 'popular' | 'new' | 'budget' | 'pro' | 'comingSoon';

/** How a model's price is quoted ("credits per 5s or per image"). */
export type PriceUnit = 'per5s' | 'per10s' | 'perImage' | 'perMinute';

export interface ModelOption {
  /** Listed behind "More models" instead of the main list. */
  more?: boolean;
  /** Catalog id, e.g. `bytedance/seedance-2.5`. */
  id: string;
  /** Display name, e.g. "Seedance 2.5". */
  name: string;
  /** 1–3 letter mark shown in the tile. */
  mark: string;
  /** Tile background color. */
  tone: string;
  /** Capability tags, already localized. */
  tags: string[];
  /** Credits per `unit`; ignored for `perMinute`. */
  credits: number;
  unit: PriceUnit;
  /** Typical duration, e.g. "~2 min". */
  eta: string;
  badge?: ModelBadge;
  /** Not selectable; show `disabledReason` as the tooltip. */
  disabled?: boolean;
  disabledReason?: string;
  /** Output resolutions the model offers (catalog); its smallest decides the plan it needs (D-006). */
  resolutions?: string[];
  /** Output kind, for the plan cap that applies. */
  media?: 'video' | 'image';
}

export type VideoAspect = 'Auto' | '9:16' | '16:9' | '1:1' | '4:3' | '3:4';

export interface VideoParams {
  aspectRatio: VideoAspect;
  resolution: '480p' | '720p' | '1080p';
  duration: '5s' | '10s' | '15s' | '30s';
  count: '1' | '2' | '4';
  audio: boolean;
}

export interface ImageParams {
  aspectRatio: VideoAspect;
  quality: 'standard' | 'high';
  size: '1K' | '2K' | '4K';
  count: '1' | '2' | '4';
}

/** Row state in a run plan (handoff 3: run / reuse / blocked / nothing to generate). */
export type RunRowState = 'run' | 'reuse' | 'blocked' | 'free';

export type RunRowKind = 'video' | 'image' | 'audio' | 'text';

export interface RunPlanRow {
  id: string;
  /** e.g. "Shot A · Hero shot". */
  name: string;
  /** e.g. "Seedance 2.5 · First frame · 720p 5s · Input changed". */
  meta: string;
  kind: RunRowKind;
  state: RunRowState;
  /** Quoted credits for this row; only `run` rows are charged. */
  cost: number;
  /** A `run` row for a node with no result yet: labelled “Generate” instead of “Regenerate”. */
  fresh?: boolean;
  /** Tile color; defaults by kind. */
  tone?: string;
}

export interface PaywallOption {
  /** Plan id (`starter`, `plus`, `pro`) or `topup_<usd>`. */
  id: string;
  name: string;
  meta: string;
  /** Formatted price, e.g. "$15/mo" or "$25". */
  price: string;
  kind?: 'plan' | 'topup';
  /** Top-ups: the amount and the credits it buys (bonus included; the server re-quotes). */
  amountUsd?: number;
  credits?: number;
}

export interface ResultVersion {
  id: string;
  /** e.g. "v2". */
  label: string;
  /** Placeholder tile color when there is no thumbnail. */
  tone?: string;
  thumbnailUrl?: string;
  /** D-020: the prompt this version rendered when the gateway rewrote it ("Enhanced prompt"). */
  expandedPrompt?: string;
}

export interface ResultParam {
  label: string;
  value: string;
}

export interface ResultAsset {
  id: string;
  name: string;
  tone?: string;
  thumbnailUrl?: string;
}

export type ResultActionId = 'edit' | 'regenerate' | 'extend' | 'hd' | 'sendToCanvas' | 'download';

export interface ResultAction {
  id: ResultActionId;
  /** Credits it will cost, shown after the label; omit for free actions. */
  cost?: number;
  disabled?: boolean;
}
