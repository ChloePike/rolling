/** A template, shaped like a `GET /api/templates` row. */
export interface TemplateSummary {
  id: string;
  name: string;
  /** Featured templates only. */
  description?: string;
  durationSec: number;
  uses: number;
  /** Number of characters (roles) to cast. */
  roles: number;
  hasLines: boolean;
  /** Featured templates only. */
  tags?: string[];
  /** Cover aspect ratio as CSS `aspect-ratio`, e.g. `9/16`. */
  coverAspect: string;
  category: TemplateCategory;
  featured?: boolean;
  /** Real mode (`GET /api/templates`): the ratio it is made in, e.g. `9:16`. */
  ratio?: string;
  /** `builtin` or `workspace` (saved from a canvas selection). */
  source?: 'builtin' | 'workspace';
  nodeCount?: number;
  /** Agent skill the template matches (Home inspiration → Agent mode). */
  skill?: string | null;
  /** Signed cover picture; never mature (D-005). */
  coverUrl?: string | null;
  /** Built-in poster in each format with its size and average color (`TemplateMedia`). */
  cover?: TemplateCover | null;
  /** Muted looping MP4 preview of video templates. */
  previewUrl?: string | null;
  /** What to fill when making a project from it (asset and text nodes). */
  slots?: TemplateSlot[];
}

export interface TemplateCover {
  jpg: string;
  webp: string | null;
  avif: string | null;
  width: number;
  height: number;
  /** `#rrggbb`: the card's fill while the poster loads. */
  color: string | null;
}

export interface TemplateSlot {
  /** Node id in the template graph (the key of a fill). */
  id: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  label: string;
  param: 'assetId' | 'text';
  required: boolean;
  default?: string;
}

/** `GET /api/templates/:id`: a template and its canvas graph. */
export interface TemplateDetail extends TemplateSummary {
  graph: {
    nodes: Array<{ id: string; kind: 'text' | 'script' | 'image' | 'video' | 'audio' | 'asset' | 'render'; title: string; params: Record<string, unknown>; position: { x: number; y: number }; groupId: string | null }>;
    edges: Array<{ id: string; from: { node: string; port: string }; to: { node: string; port: string } }>;
    groups: Array<{ id: string; title: string; nodeIds: string[] }>;
  };
}

export type TemplateCategory =
  | 'product'
  | 'explainer'
  | 'drama'
  | 'holiday'
  | 'venue'
  | 'outfit'
  | 'comic'
  | 'talking';
