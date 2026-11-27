/**
 * The price function: USD cost of one gateway request from a model's listed
 * price rules. Kept apart from `./catalog.ts` (the listing parser, which needs
 * zod) so clients that only price, like the web app's pricing config, stay small.
 */
import type { CatalogKind, ListingModel, PriceRule } from './types';

/** Price line of the gateway's prompt expansion (its most, held with the render). */
export const PROMPT_EXPAND_METER = 'prompt_expand';

/** Meters `usdCost` knows how to count. */
export const PRICED_METERS: ReadonlySet<string> = new Set(['video_second', 'image', 'input_image', 'input_video_ms', 'request']);

/** The meter that prices a kind's output. */
export const OUTPUT_METER: Partial<Record<CatalogKind, string>> = { image: 'image', video: 'video_second' };

/** What a price depends on. Unset values fall back to the model's defaults. */
export interface PriceRequest {
  resolution?: string;
  /** Output length in seconds (video). */
  seconds?: number;
  audio?: boolean;
  /** Images per request. */
  n?: number;
  /** `WxH` (image). */
  size?: string;
  quality?: string;
  /** Pictures sent in any slot: edit inputs, first/last frame, reference images. */
  inputImages?: number;
  /** Reference clips sent. */
  referenceVideos?: number;
  /**
   * Total length of input clips in ms. Only when it is known does the
   * reference-video rate (`video_input`) apply, together with the per-ms input
   * charge; otherwise the higher text/image-driven rate is used (conservative).
   */
  inputVideoMs?: number;
  /** Values for listing conditions without a named field. */
  conditions?: Record<string, string | number | boolean>;
  /**
   * Most the gateway's prompt expansion can cost (USD at the writer's token
   * prices, `promptExpansionMaxUsd`). Billed on the same request; priced only
   * on models that take `prompt_expand`.
   */
  promptExpandUsd?: number;
}

export interface PriceLine {
  meter: string;
  units: number;
  usdPerUnit: number;
  usd: number;
  conditions: PriceRule['conditions'];
}

function pixelsOf(size: string | undefined): number | undefined {
  const m = size?.match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  return m ? Number(m[1]) * Number(m[2]) : undefined;
}

function conditionValue(model: ListingModel, req: PriceRequest, key: string): string | number | boolean | undefined {
  switch (key) {
    case 'resolution':
      return req.resolution ?? model.defaultResolution;
    case 'video_input':
      return (req.inputVideoMs ?? 0) > 0;
    case 'input_images':
      return req.inputImages ?? 0;
    case 'audio':
      return req.audio ?? false;
    case 'quality':
      return req.quality;
    case 'pixels':
      return pixelsOf(req.size ?? model.defaultSize);
    default:
      return req.conditions?.[key];
  }
}

function ruleMatches(model: ListingModel, req: PriceRequest, rule: PriceRule): boolean {
  for (const [key, want] of Object.entries(rule.conditions)) {
    const bound = /^(min|max)_(.+)$/.exec(key);
    if (bound && typeof want === 'number') {
      const have = conditionValue(model, req, bound[2]!);
      if (typeof have !== 'number') return false;
      if (bound[1] === 'min' ? have < want : have > want) return false;
      continue;
    }
    if (conditionValue(model, req, key) !== want) return false;
  }
  return true;
}

function unitsFor(model: ListingModel, req: PriceRequest, meter: string): number | null {
  switch (meter) {
    case 'video_second':
      return req.seconds ?? model.defaultSeconds ?? model.seconds?.min ?? null;
    case 'image':
      return req.n ?? 1;
    case 'input_image':
      return req.inputImages ?? 0;
    case 'input_video_ms':
      return req.inputVideoMs ?? 0;
    case 'request':
      return 1;
    default:
      return 0;
  }
}

/**
 * Itemized USD cost of one request, or null when it cannot be priced (the
 * output meter has no rule for the asked resolution, or the length is unknown).
 * Per meter, the most specific matching rule wins; ties go to the higher price.
 */
export function priceLines(model: ListingModel, req: PriceRequest = {}): PriceLine[] | null {
  const outputMeter = OUTPUT_METER[model.kind];
  if (!outputMeter) return null;
  const meters = [...new Set(model.price.map((r) => r.meter))].filter((m) => PRICED_METERS.has(m));
  const lines: PriceLine[] = [];
  for (const meter of meters) {
    let best: PriceRule | null = null;
    for (const rule of model.price) {
      if (rule.meter !== meter || !ruleMatches(model, req, rule)) continue;
      const spec = Object.keys(rule.conditions).length;
      const bestSpec = best ? Object.keys(best.conditions).length : -1;
      if (spec > bestSpec || (spec === bestSpec && rule.usd > best!.usd)) best = rule;
    }
    if (!best) {
      if (meter === outputMeter) return null;
      continue;
    }
    const raw = unitsFor(model, req, meter);
    if (raw === null) return null;
    if (raw <= 0 && best.minUnits <= 0) continue;
    const units = Math.max(best.minUnits, Math.ceil(raw / best.unitStep) * best.unitStep);
    lines.push({ meter, units, usdPerUnit: best.usd, usd: best.usd * units, conditions: best.conditions });
  }
  if (!lines.some((l) => l.meter === outputMeter)) return null;
  const expand = req.promptExpandUsd;
  if (expand !== undefined && Number.isFinite(expand) && expand > 0 && model.params.promptExpand) {
    lines.push({ meter: PROMPT_EXPAND_METER, units: 1, usdPerUnit: expand, usd: expand, conditions: {} });
  }
  return lines;
}

/** Total USD cost of one request at the gateway, or null when it cannot be priced. */
export function usdCost(model: ListingModel, req: PriceRequest = {}): number | null {
  const lines = priceLines(model, req);
  if (!lines) return null;
  // Round away float noise (prices have up to 9 decimals).
  return Math.round(lines.reduce((s, l) => s + l.usd, 0) * 1e9) / 1e9;
}
