/**
 * Node params → generation settings. Canvas nodes carry UI-shaped params
 * (`model` as id or display name, `length`/`seconds`, `resolution`, `ratio`,
 * `count`, `audio` or the `extra` label); tool pages send a `PromptSpec`.
 */
import { z } from 'zod';
import type { Catalog } from '../models/catalog';
import type { CatalogModel } from '../models/types';

export const AUTO_MODEL = 'auto';

/** `@[Product photo]` mentions become plain names in the prompt. */
export function cleanPrompt(text: string): string {
  return text.replace(/@\[([^\]]*)\]/g, '$1').replace(/\s+/g, ' ').trim();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?s?$/.test(v.trim())) return Number.parseFloat(v);
  return undefined;
}

/** Text a text/script node feeds downstream. */
export function textOfNode(params: Record<string, unknown>): string {
  const direct = str(params.text) ?? str(params.prompt) ?? str(params.script);
  if (direct) return cleanPrompt(direct);
  if (Array.isArray(params.rows)) {
    const parts: string[] = [];
    for (const row of params.rows) {
      if (typeof row === 'string') parts.push(row);
      else if (row && typeof row === 'object') {
        for (const v of Object.values(row as Record<string, unknown>)) if (typeof v === 'string' && v.trim()) parts.push(v);
      }
    }
    return cleanPrompt(parts.join(' '));
  }
  return '';
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

/** Model a node asks for: `auto`, a catalog model, or `unknown` with the raw value. */
export function modelRefOf(params: Record<string, unknown>): string {
  return str(params.modelId) ?? str(params.model) ?? AUTO_MODEL;
}

export function isAuto(ref: string): boolean {
  return ref.toLowerCase() === AUTO_MODEL;
}

/**
 * Resolves a model reference by id, display name or the PRD name it stands in
 * for (`substituteFor`, e.g. "Seedream 5.0 Pro"). Hidden ids resolve too (the
 * Berry routes serve hidden Wan ids), but chat models never do.
 */
export function findModel(catalog: Catalog, ref: string): CatalogModel | null {
  const byId = catalog.get(ref);
  if (byId && byId.kind !== 'chat') return byId;
  const want = normalizeName(ref);
  const media = catalog.models.filter((m) => m.kind !== 'chat');
  return (
    media.find((m) => !m.hidden && normalizeName(m.displayName) === want) ??
    media.find((m) => !m.hidden && m.substituteFor !== undefined && normalizeName(m.substituteFor) === want) ??
    media.find((m) => normalizeName(m.displayName) === want) ??
    null
  );
}

export interface NodeSettings {
  seconds?: number;
  resolution?: string;
  ratio?: string;
  audio?: boolean;
  n?: number;
  negativePrompt?: string;
  seed?: number;
  /** The node asks for a mature run (D-005). */
  mature: boolean;
  /** Reference-mode video (frames sent as reference images). */
  refsMode: boolean;
}

export function settingsOf(kind: 'image' | 'video', params: Record<string, unknown>): NodeSettings {
  const seconds = kind === 'video' ? (num(params.length) ?? num(params.seconds) ?? num(params.duration)) : undefined;
  let audio: boolean | undefined;
  if (typeof params.audio === 'boolean') audio = params.audio;
  else if (typeof params.extra === 'string') {
    if (/audio off/i.test(params.extra)) audio = false;
    else if (/audio on/i.test(params.extra)) audio = true;
  }
  const count = num(params.count);
  return {
    ...(seconds !== undefined && { seconds: Math.round(seconds) }),
    ...(str(params.resolution) && { resolution: str(params.resolution)! }),
    ...(str(params.ratio) && { ratio: str(params.ratio)! }),
    ...(kind === 'video' && audio !== undefined && { audio }),
    ...(kind === 'image' && count !== undefined && count > 1 && { n: Math.floor(count) }),
    ...(str(params.negativePrompt) && { negativePrompt: str(params.negativePrompt)! }),
    ...(typeof params.seed === 'number' && Number.isInteger(params.seed) && { seed: params.seed }),
    mature: params.mature === true,
    refsMode: typeof params.mode === 'string' && /reference/i.test(params.mode),
  };
}

/** Tool page request (Quick create, Motion, ...) without a graph. */
export const PromptSpecSchema = z.object({
  kind: z.enum(['image', 'video']),
  model: z.string().min(1).max(128).default(AUTO_MODEL),
  prompt: z.string().max(8000).default(''),
  title: z.string().max(200).optional(),
  seconds: z.number().int().positive().max(120).optional(),
  resolution: z.string().max(16).optional(),
  ratio: z.string().max(16).optional(),
  audio: z.boolean().optional(),
  n: z.number().int().min(1).max(8).optional(),
  negativePrompt: z.string().max(2000).optional(),
  seed: z.number().int().optional(),
  mature: z.boolean().optional(),
  /** Reference-mode video: images as references, not frames. */
  refsMode: z.boolean().optional(),
  inputs: z
    .object({
      firstFrameAssetId: z.string().max(64).optional(),
      lastFrameAssetId: z.string().max(64).optional(),
      referenceAssetIds: z.array(z.string().max(64)).max(9).optional(),
      inputAssetIds: z.array(z.string().max(64)).max(10).optional(),
      audioAssetId: z.string().max(64).optional(),
    })
    .default({}),
});
export type PromptSpec = z.infer<typeof PromptSpecSchema>;

/** Image models priced and sized by `size` (no resolution list): resolution label + ratio → `WxH`. */
export function usesSize(model: Pick<CatalogModel, 'kind' | 'resolutions' | 'params'>): boolean {
  return model.kind === 'image' && model.resolutions.length === 0 && model.params.size;
}

const K_SIDE: Record<string, number> = { '1k': 1024, '2k': 2048, '4k': 4096 };

/**
 * `WxH` for an image of `resolution` (1K/2K/4K: the pixel budget of a square of
 * that side) at `ratio` (e.g. 9:16), both sides multiples of 64. Null when the
 * labels are not understood (the model default applies).
 */
export function imageSizeFor(resolution: string | undefined, ratio: string | undefined): string | null {
  if (resolution === undefined && (ratio === undefined || ratio === 'adaptive')) return null;
  const side = resolution ? K_SIDE[resolution.toLowerCase()] : 2048;
  if (!side) return null;
  const m = ratio ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio) : null;
  const r = m ? Number(m[1]) / Number(m[2]) : 1;
  if (!Number.isFinite(r) || r <= 0) return null;
  const pixels = side * side;
  const round = (v: number) => Math.max(64, Math.round(v / 64) * 64);
  const w = round(Math.sqrt(pixels * r));
  const h = round(pixels / Math.sqrt(pixels * r));
  return `${w}x${h}`;
}
