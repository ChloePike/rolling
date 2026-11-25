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
