/**
 * Brand kit (D-035), one per workspace: logo (an image asset), brand colors,
 * uploaded fonts (woff2 / ttf / otf in R2, with the uploader's license
 * confirmation), intro and outro cards, the watermark position, and a short
 * tone note. Exports can apply it (logo watermark, cards); caption looks use
 * its caption font and primary color; the agent's context gets a summary.
 */
import { z } from 'zod';

export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
export const BRAND_LIMITS = { colors: 6, fonts: 4, fontBytes: 4 * 1024 * 1024, cardText: 80, tone: 500, cardSeconds: [1, 5] } as const;
export const FONT_FORMATS = ['woff2', 'ttf', 'otf'] as const;
export type FontFormat = (typeof FONT_FORMATS)[number];
export const WATERMARK_POSITIONS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

const Color = z.string().regex(HEX_COLOR).transform((c) => c.toUpperCase());

export const BrandFontSchema = z.object({
  id: z.string().regex(/^fnt_[A-Za-z0-9]{6,40}$/),
  /** The family name shown and used in CSS / ASS (the container reads the file's own names too). */
  family: z.string().trim().min(1).max(64),
  fileName: z.string().max(200),
  format: z.enum(FONT_FORMATS),
  size: z.number().int().positive().max(BRAND_LIMITS.fontBytes),
  /** The uploader confirmed the font's license allows this use. */
  licenseConfirmed: z.literal(true),
});
export type BrandFont = z.infer<typeof BrandFontSchema>;

export const BrandCardSchema = z.object({
  enabled: z.boolean(),
  text: z.string().trim().max(BRAND_LIMITS.cardText).default(''),
  seconds: z.number().min(BRAND_LIMITS.cardSeconds[0]).max(BRAND_LIMITS.cardSeconds[1]).default(2),
  /** Null = the first brand color (else black). */
  background: Color.nullable().default(null),
  showLogo: z.boolean().default(true),
});
export type BrandCard = z.infer<typeof BrandCardSchema>;

export const WatermarkSchema = z.object({
  enabled: z.boolean(),
  position: z.enum(WATERMARK_POSITIONS).default('bottom_right'),
  opacity: z.number().min(0.2).max(1).default(0.85),
  /** Logo width as a share of the frame width. */
  size: z.number().min(0.05).max(0.3).default(0.12),
});
export type Watermark = z.infer<typeof WatermarkSchema>;

const CARD_OFF: BrandCard = { enabled: false, text: '', seconds: 2, background: null, showLogo: true };

/** What a client may set (`PUT /api/brand-kit`); fonts are added through their own upload. */
export const BrandKitInputSchema = z.object({
  logoAssetId: z.string().min(1).max(64).nullable().default(null),
  colors: z.array(Color).max(BRAND_LIMITS.colors).default([]),
  /** Font ids (from `fonts`) for headings and cards, and for captions; null = the default font. */
  headingFontId: z.string().max(48).nullable().default(null),
  captionFontId: z.string().max(48).nullable().default(null),
  intro: BrandCardSchema.default(CARD_OFF),
  outro: BrandCardSchema.default(CARD_OFF),
  watermark: WatermarkSchema.default({ enabled: false, position: 'bottom_right', opacity: 0.85, size: 0.12 }),
  tone: z.string().trim().max(BRAND_LIMITS.tone).default(''),
});
export type BrandKitInput = z.infer<typeof BrandKitInputSchema>;

export interface BrandKit extends BrandKitInput {
  fonts: BrandFont[];
  updatedAt: number | null;
}

export function emptyBrandKit(): BrandKit {
  return { ...BrandKitInputSchema.parse({}), fonts: [], updatedAt: null };
}

/** Font format from the file name / content type, or null when it is not one we take. */
export function fontFormatOf(fileName: string, contentType?: string | null): FontFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'woff2' || contentType === 'font/woff2') return 'woff2';
  if (ext === 'ttf' || contentType === 'font/ttf') return 'ttf';
  if (ext === 'otf' || contentType === 'font/otf') return 'otf';
  return null;
}

/** Checks the file's signature matches its format (`wOF2`, TrueType `0x00010000`/`true`, OpenType `OTTO`). */
export function fontSignatureOk(format: FontFormat, head: Uint8Array): boolean {
  const tag = String.fromCharCode(...head.slice(0, 4));
  if (format === 'woff2') return tag === 'wOF2';
  if (format === 'otf') return tag === 'OTTO';
  return (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0) || tag === 'true';
}

/** A family name from a file name (`Inter-Bold.woff2` → `Inter Bold`). */
export function familyFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Brand font').slice(0, 64);
}

export function fontById(kit: Pick<BrandKit, 'fonts'>, id: string | null | undefined): BrandFont | null {
  return (id && kit.fonts.find((f) => f.id === id)) || null;
}

/** A kit with references to removed fonts cleared. */
export function normalizeBrandKit(kit: BrandKit): BrandKit {
  const has = (id: string | null) => (id && kit.fonts.some((f) => f.id === id) ? id : null);
  return { ...kit, headingFontId: has(kit.headingFontId), captionFontId: has(kit.captionFontId) };
}

export function hasBrandKit(kit: BrandKit | null | undefined): kit is BrandKit {
  return !!kit && (kit.logoAssetId !== null || kit.colors.length > 0 || kit.fonts.length > 0 || kit.tone !== '' || kit.intro.enabled || kit.outro.enabled);
}

/** Exports can apply something from the kit (a watermark with a logo, or a card). */
export function brandAppliesToExport(kit: BrandKit | null | undefined): boolean {
  return !!kit && ((kit.watermark.enabled && kit.logoAssetId !== null) || kit.intro.enabled || kit.outro.enabled);
}

/** One paragraph for the agent's context: colors, fonts, cards and the tone note (plain data, no instructions). */
export function brandKitSummary(kit: BrandKit | null | undefined): string | null {
  if (!hasBrandKit(kit)) return null;
  const parts: string[] = [];
  if (kit.colors.length) parts.push(`colors ${kit.colors.join(', ')} (primary ${kit.colors[0]})`);
  const heading = fontById(kit, kit.headingFontId);
  const caption = fontById(kit, kit.captionFontId);
  if (heading) parts.push(`heading font “${heading.family}”`);
  if (caption) parts.push(`caption font “${caption.family}”`);
  if (kit.logoAssetId) parts.push(kit.watermark.enabled ? `logo watermark ${kit.watermark.position.replace('_', ' ')}` : 'a logo');
  if (kit.intro.enabled) parts.push(`intro card${kit.intro.text ? ` “${kit.intro.text}”` : ''}`);
  if (kit.outro.enabled) parts.push(`end card${kit.outro.text ? ` “${kit.outro.text}”` : ''}`);
  const tone = kit.tone ? ` Tone: ${kit.tone.replace(/\s+/g, ' ')}` : '';
  return `Brand kit: ${parts.join('; ') || 'set'}.${tone}`;
}
