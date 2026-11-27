/**
 * Model catalog from the live Hyperouter listing (D-002: "Model catalog is
 * driven by the live listing"). `parseListing` turns `GET /v1/models` into
 * normalized ListingModel entries; `Catalog` merges them with the product
 * overlay (`./overlay.ts`). The listing wins for every technical and price
 * field; the overlay only adds product fields.
 *
 * Parsing is tolerant: unknown fields are kept out of the way (Zod passthrough),
 * malformed optional fields fall back to defaults, and an entry that cannot be
 * used at all is skipped with a reason instead of failing the whole listing.
 */
import { z } from 'zod';
import { MODEL_OVERLAY, mergeModel, type ModelOverlay } from './overlay';
import type { CatalogKind, CatalogModel, GenerationMode, ListingModel, PriceRule } from './types';

// ---------------------------------------------------------------------------
// Listing schema (only what we read; everything else passes through)
// ---------------------------------------------------------------------------

const zListing = z.object({ data: z.array(z.unknown()) }).passthrough();

const zEntry = z
  .object({
    id: z.string().min(1),
    name: z.string().catch(''),
    kind: z.string(),
    param_schema: z.unknown().optional(),
    prices: z.array(z.unknown()).catch([]),
    pricing: z.record(z.unknown()).catch({}),
    supported_parameters: z.array(z.string()).catch([]),
    operations: z.array(z.string()).catch([]),
    response_modes: z.array(z.string()).catch([]),
    input_image_required: z.boolean().catch(false),
    edit_only: z.boolean().catch(false),
    min_input_images: z.number().int().nonnegative().optional().catch(undefined),
    max_input_images: z.number().int().nonnegative().optional().catch(undefined),
    extra_parameters: z.record(z.unknown()).catch({}),
  })
  .passthrough();

const zParamSchema = z
  .object({
    properties: z.record(z.unknown()).catch({}),
    required: z.array(z.string()).catch([]),
    exclusive: z.array(z.array(z.array(z.string()))).catch([]),
    needs: z.record(z.array(z.string())).catch({}),
  })
  .passthrough();

const zProperty = z
  .object({
    type: z.string().optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().catch(undefined),
    minimum: z.number().optional().catch(undefined),
    maximum: z.number().optional().catch(undefined),
    minItems: z.number().int().nonnegative().optional().catch(undefined),
    maxItems: z.number().int().nonnegative().optional().catch(undefined),
  })
  .passthrough();
type Property = z.infer<typeof zProperty>;

const zExtraParam = z.object({ description: z.string().optional().catch(undefined) }).passthrough();

const zPrice = z
  .object({
    meter: z.string().min(1),
    conditions: z.record(z.unknown()).catch({}),
    usd: z.union([z.string(), z.number()]),
    min_units: z.number().nonnegative().catch(0),
    unit_step: z.number().positive().catch(1),
  })
  .passthrough();

const KNOWN_ENTRY_FIELDS = new Set([
  'id', 'name', 'kind', 'context_length', 'architecture', 'pricing', 'top_provider', 'response_modes',
  'supported_parameters', 'input_image_required', 'extra_parameters', 'param_schema', 'prices',
  'request_example', 'min_input_images', 'max_input_images', 'edit_only', 'operations',
]);

/** Parameters that map to GenerateRequest fields (or are handled by the adapter). Others go through `extra`. */
const MAPPED_PARAMS = new Set([
  'prompt', 'resolution', 'seconds', 'ratio', 'seed', 'audio', 'reference_images', 'reference_videos',
  'reference_audios', 'first_frame', 'last_frame', 'prompt_extend', 'prompt_expand', 'n', 'size', 'response_format',
  'images', 'negative_prompt', 'audio_url', 'moderation', 'input_reference', 'watermark',
]);

/** Price line of the gateway's prompt expansion (its most, held with the render). */
export const PROMPT_EXPAND_METER = 'prompt_expand';

/** Meters `usdCost` knows how to count. */
const PRICED_METERS = new Set(['video_second', 'image', 'input_image', 'input_video_ms', 'request']);
/** Chat token meters: known, but not priced by `usdCost` (chat cost is settled from usage). */
const CHAT_METERS = new Set(['prompt', 'completion', 'input_cache_read', 'cache_write_tokens', 'web_search']);
const KNOWN_CONDITIONS = new Set(['resolution', 'video_input', 'input_images', 'min_pixels', 'quality', 'audio']);

const KINDS: readonly CatalogKind[] = ['image', 'video', 'chat'];
const OUTPUT_METER: Partial<Record<CatalogKind, string>> = { image: 'image', video: 'video_second' };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface SkippedModel {
  /** Listing id when one could be read. */
  id: string | null;
  reason: string;
}

export interface ParsedListing {
  models: ListingModel[];
  skipped: SkippedModel[];
}

export class ListingParseError extends Error {
  override readonly name = 'ListingParseError';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds the enum value the description names as default (`Default \`480p\``, `\`768p\` (the default)`, `1K (default)`). */
export function defaultFromDescription(values: readonly string[], description: string | undefined): string | undefined {
  if (!description) return undefined;
  for (const v of values) {
    const e = escapeRegExp(v);
    const re = new RegExp(`default[:\\s]*\`?${e}\`?(?!\\w)|\`?${e}\`?\\s*\\((?:the )?default\\)`, 'i');
    if (re.test(description)) return v;
  }
  return undefined;
}

function upToFromDescription(description: string | undefined): number | undefined {
  const m = description?.match(/up to (\d+)/i);
  return m ? Number(m[1]) : undefined;
}

function scalarConditions(raw: Record<string, unknown>): Record<string, string | number | boolean> | null {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else return null;
  }
  return out;
}

function parsePrices(entry: z.infer<typeof zEntry>, unmapped: string[]): PriceRule[] {
  const rules: PriceRule[] = [];
  for (const raw of entry.prices) {
    const p = zPrice.safeParse(raw);
    if (!p.success) {
      unmapped.push('price:unparseable');
      continue;
    }
    const usd = Number(p.data.usd);
    const conditions = scalarConditions(p.data.conditions);
    // A rule whose conditions we cannot read must not become unconditional: drop it.
    if (!Number.isFinite(usd) || usd < 0 || conditions === null) {
      unmapped.push(`price:${p.data.meter}:unreadable`);
      continue;
    }
    if (!PRICED_METERS.has(p.data.meter) && !CHAT_METERS.has(p.data.meter)) unmapped.push(`meter:${p.data.meter}`);
    for (const k of Object.keys(conditions)) if (!KNOWN_CONDITIONS.has(k)) unmapped.push(`condition:${k}`);
    rules.push({ meter: p.data.meter, conditions, usd, minUnits: p.data.min_units, unitStep: p.data.unit_step });
  }
  // Older listings carried only the flat `pricing` map: fall back to it for the output meter.
  for (const meter of ['image', 'video_second']) {
    if (rules.some((r) => r.meter === meter)) continue;
    const flat = Number(entry.pricing[meter]);
    if (Number.isFinite(flat) && flat > 0) rules.push({ meter, conditions: {}, usd: flat, minUnits: 0, unitStep: 1 });
  }
  return rules;
}

function deriveModel(entry: z.infer<typeof zEntry>, kind: CatalogKind): ListingModel {
  const unmapped: string[] = [];
  for (const k of Object.keys(entry)) if (!KNOWN_ENTRY_FIELDS.has(k)) unmapped.push(`field:${k}`);

  const schema = zParamSchema.safeParse(entry.param_schema ?? {});
  const ps = schema.success ? schema.data : { properties: {}, required: [], exclusive: [], needs: {} };
  if (!schema.success) unmapped.push('param_schema:unparseable');
  for (const k of Object.keys(ps)) {
    if (!['type', 'properties', 'required', 'exclusive', 'needs'].includes(k)) unmapped.push(`param_schema:${k}`);
  }

  const props: Record<string, Property> = {};
  for (const [name, raw] of Object.entries(ps.properties)) {
    const p = zProperty.safeParse(raw);
    props[name] = p.success ? p.data : {};
    if (!p.success) unmapped.push(`param:${name}:unparseable`);
  }
  const extras: Record<string, z.infer<typeof zExtraParam>> = {};
  for (const [name, raw] of Object.entries(entry.extra_parameters)) {
    const p = zExtraParam.safeParse(raw);
    extras[name] = p.success ? p.data : {};
  }
  const supported = new Set(entry.supported_parameters);
  const has = (name: string) => name in props || supported.has(name) || name in extras;
  const acceptedParams = [...new Set([...Object.keys(props), ...supported, ...Object.keys(extras)])].sort();

  if (kind !== 'chat') {
    for (const name of acceptedParams) if (!MAPPED_PARAMS.has(name)) unmapped.push(`param:${name}`);
  }

  const strEnum = (name: string): string[] =>
    (props[name]?.enum ?? []).filter((v): v is string => typeof v === 'string');
  const maxItems = (name: string): number => {
    if (props[name]?.maxItems !== undefined) return props[name]!.maxItems!;
    if (name in props) return upToFromDescription(props[name]!.description) ?? 0;
    if (name in extras) {
      const n = upToFromDescription(extras[name]!.description);
      if (n === undefined) unmapped.push(`param:${name}:no-limit`);
      return n ?? 0;
    }
    return 0;
  };

  // Seconds
  let seconds: ListingModel['seconds'];
  let defaultSeconds: number | undefined;
  const sec = props.seconds;
  if (sec) {
    const allowed = (sec.enum ?? []).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    if (allowed.length > 0) seconds = { min: allowed[0]!, max: allowed.at(-1)!, allowed };
    else if (sec.minimum !== undefined && sec.maximum !== undefined) seconds = { min: sec.minimum, max: sec.maximum };
    else unmapped.push('param:seconds:no-range');
    const d = sec.description?.match(/default:?\s*(\d+)/i);
    if (d && seconds) {
      const v = Number(d[1]);
      if (seconds.allowed ? seconds.allowed.includes(v) : v >= seconds.min && v <= seconds.max) defaultSeconds = v;
    }
    if (seconds && defaultSeconds === undefined) defaultSeconds = seconds.min;
  }

  const resolutions = strEnum('resolution');
  const defaultResolution =
    defaultFromDescription(resolutions, props.resolution?.description) ?? resolutions[0];
  const defaultSize = props.size?.description?.match(/default:?\s*(\d+x\d+)/i)?.[1];

  const maxInputImages = entry.max_input_images ?? props.images?.maxItems ?? 0;
  const minInputImages = entry.min_input_images ?? props.images?.minItems ?? 0;
  const maxReferenceImages = kind === 'video' ? maxItems('reference_images') : 0;
  const maxReferenceVideos = kind === 'video' ? maxItems('reference_videos') : 0;
  const maxReferenceAudios = kind === 'video' ? maxItems('reference_audios') : 0;
  const lipSync = kind === 'video' && has('audio_url');

  // Operations, from the shape of the parameter schema.
  const operations: GenerationMode[] = [];
  const unmappedOperations: string[] = [];
  if (kind === 'image') {
    const isSwap = entry.edit_only && !('prompt' in props) && minInputImages >= 2;
    if (isSwap) operations.push(/head/i.test(entry.id) ? 'head_swap' : 'face_swap');
    else {
      if (!entry.edit_only) operations.push('t2i');
      if (maxInputImages > 0) operations.push('edit');
    }
  } else if (kind === 'video') {
    const isSwap = has('pairs') || has('people');
    const isMotion = strEnum('mode').includes('animate');
    if (isSwap) operations.push(/head/i.test(entry.id) ? 'head_swap' : 'face_swap');
    else if (isMotion) operations.push('motion_transfer');
    else {
      const firstFrame = has('first_frame') || entry.input_image_required;
      if (!entry.input_image_required) operations.push('t2v');
      if (firstFrame) operations.push('i2v');
      if (firstFrame && has('last_frame')) operations.push('first_last_frame');
      if (maxReferenceImages > 0 || maxReferenceVideos > 0) operations.push('refs');
      if (lipSync) operations.push('lip_sync');
    }
  }
  for (const op of entry.operations) {
    if (op === 'extend' && kind === 'video') operations.push('extend');
    else unmappedOperations.push(op);
  }

  const sizeProp = props.size;
  return {
    id: entry.id,
    name: entry.name || entry.id,
    kind,
    operations,
    unmappedOperations,
    ...(seconds && { seconds }),
    ...(defaultSeconds !== undefined && { defaultSeconds }),
    resolutions,
    ...(defaultResolution !== undefined && { defaultResolution }),
    ...(defaultSize !== undefined && { defaultSize }),
    ratios: strEnum('ratio'),
    audio: kind === 'video' && has('audio'),
    lipSync,
    maxReferenceImages,
    maxReferenceVideos,
    maxReferenceAudios,
    minInputImages: kind === 'image' ? minInputImages : 0,
    maxInputImages: kind === 'image' ? maxInputImages : 0,
    inputImageRequired: entry.input_image_required,
    maxImagesPerRequest: kind === 'image' ? (props.n?.maximum ?? 1) : 1,
    params: {
      seed: has('seed'),
      negativePrompt: has('negative_prompt'),
      promptExtend: has('prompt_extend'),
      promptExpand: kind !== 'chat' && has('prompt_expand'),
      // Some schemas list `size` only to say it is ignored.
      size: sizeProp !== undefined && !/^\s*ignored/i.test(sizeProp.description ?? ''),
    },
    acceptedParams,
    requiredParams: ps.required,
    exclusive: ps.exclusive,
    needs: ps.needs,
    supportsModeration: has('moderation'),
    responseModes: entry.response_modes,
    price: parsePrices(entry, unmapped),
    unmapped: [...new Set(unmapped)].sort(),
  };
}

/**
 * Normalizes a `GET /v1/models` body. Throws ListingParseError only when the
 * body has no `data` array; single bad entries are skipped with a reason.
 */
export function parseListing(json: unknown): ParsedListing {
  const listing = zListing.safeParse(json);
  if (!listing.success) throw new ListingParseError('Listing has no data array.');
  const models: ListingModel[] = [];
  const skipped: SkippedModel[] = [];
  const seen = new Set<string>();
  for (const raw of listing.data.data) {
    const e = zEntry.safeParse(raw);
    if (!e.success) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : null;
      skipped.push({ id, reason: `invalid entry: ${e.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` });
      continue;
    }
    const entry = e.data;
    if (seen.has(entry.id)) {
      skipped.push({ id: entry.id, reason: 'duplicate id' });
      continue;
    }
    if (!(KINDS as readonly string[]).includes(entry.kind)) {
      skipped.push({ id: entry.id, reason: `unsupported kind "${entry.kind}"` });
      continue;
    }
    const kind = entry.kind as CatalogKind;
    let model: ListingModel;
    try {
      model = deriveModel(entry, kind);
    } catch (err) {
      skipped.push({ id: entry.id, reason: `could not derive capabilities: ${String(err)}` });
      continue;
    }
    const outputMeter = OUTPUT_METER[kind];
    if (outputMeter && !model.price.some((r) => r.meter === outputMeter)) {
      skipped.push({ id: entry.id, reason: `no ${outputMeter} price` });
      continue;
    }
    if (kind !== 'chat' && model.operations.length === 0) {
      skipped.push({ id: entry.id, reason: 'no usable operation' });
      continue;
    }
    seen.add(entry.id);
    models.push(model);
  }
  return { models, skipped };
}

// ---------------------------------------------------------------------------
// Price function
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogListOptions {
  kind?: CatalogKind;
  includeHidden?: boolean;
  /** Include adult-oriented (`matureOnly`) models. Only for callers allowed to see mature content. */
  includeMatureOnly?: boolean;
}

/** The merged model catalog (listing ∪ overlay). Immutable. */
export class Catalog {
  private readonly byId: ReadonlyMap<string, CatalogModel>;

  constructor(readonly models: readonly CatalogModel[]) {
    this.byId = new Map(models.map((m) => [m.id, m]));
  }

  /** Builds a catalog from a raw `GET /v1/models` body. */
  static fromListing(json: unknown, overlay: ModelOverlay = MODEL_OVERLAY): { catalog: Catalog; skipped: SkippedModel[] } {
    const { models, skipped } = parseListing(json);
    return { catalog: Catalog.fromListingModels(models, overlay), skipped };
  }

  /** Builds a catalog from already parsed listing models (e.g. rows synced into D1). */
  static fromListingModels(models: readonly ListingModel[], overlay: ModelOverlay = MODEL_OVERLAY): Catalog {
    return new Catalog(models.map((m) => mergeModel(m, overlay[m.id])));
  }

  get size(): number {
    return this.models.length;
  }

  get(id: string): CatalogModel | undefined {
    return this.byId.get(id);
  }

  list(opts: CatalogListOptions = {}): CatalogModel[] {
    return this.models.filter(
      (m) =>
        (opts.kind === undefined || m.kind === opts.kind) &&
        (opts.includeHidden || !m.hidden) &&
        (opts.includeMatureOnly || !m.matureOnly),
    );
  }

  /** The overlay's default model for a kind, when it is listed and not hidden. */
  defaultFor(kind: CatalogKind): CatalogModel | null {
    return this.models.find((m) => m.kind === kind && m.default && !m.hidden) ?? null;
  }
}
