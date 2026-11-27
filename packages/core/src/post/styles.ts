/**
 * Caption looks (D-033): `clean`, `bold_social`, `minimal`. One definition for
 * the editor preview (CSS) and the burn-in (the Worker resolves a look into
 * `RenderCaptions` for the FFmpeg container, which writes it as an ASS style).
 *
 * Fonts: the brand kit's caption font when set, else Noto Sans; CJK text falls
 * back to the Noto Sans CJK variant of the caption language (JP, KR, SC, TC),
 * bundled in the container (OFL). Colors: the brand's primary color tints the
 * box (clean) or the text (bold social); minimal stays white.
 */
import type { CaptionStyleId } from '../timeline/types';

export interface CaptionLook {
  id: CaptionStyleId;
  /** CSS / ASS weight: ASS takes bold on or off (>= 600 is bold). */
  weight: 400 | 500 | 700 | 800;
  /** Font size as a share of the frame's short side. */
  size: number;
  /** Text outline width as a share of the font size (0 = none). */
  outline: number;
  /** Background box behind each line (opacity 0..1), or none. */
  box: { opacity: number } | null;
  shadow: boolean;
  /** Bottom margin as a share of the frame height. */
  marginV: number;
  maxLines: 1 | 2;
  /** Characters per line before wrapping. */
  lineChars: { latin: number; cjk: number };
}

export const CAPTION_LOOKS: Record<CaptionStyleId, CaptionLook> = {
  clean: { id: 'clean', weight: 500, size: 0.05, outline: 0, box: { opacity: 0.62 }, shadow: false, marginV: 0.08, maxLines: 2, lineChars: { latin: 42, cjk: 16 } },
  bold_social: { id: 'bold_social', weight: 800, size: 0.072, outline: 0.12, box: null, shadow: true, marginV: 0.22, maxLines: 1, lineChars: { latin: 22, cjk: 10 } },
  minimal: { id: 'minimal', weight: 400, size: 0.04, outline: 0, box: null, shadow: true, marginV: 0.06, maxLines: 2, lineChars: { latin: 46, cjk: 18 } },
};

export const DEFAULT_CAPTION_FONT = 'Noto Sans';

/** The bundled Noto Sans CJK family for a caption language (glyph shapes differ by region). */
export function cjkFontFor(lang: string | null | undefined): string {
  const l = (lang ?? '').toLowerCase();
  if (l.startsWith('ja')) return 'Noto Sans CJK JP';
  if (l.startsWith('ko')) return 'Noto Sans CJK KR';
  if (l === 'zh-tw' || l === 'zh-hk' || l.startsWith('zh-hant') || l === 'yue') return 'Noto Sans CJK TC';
  return 'Noto Sans CJK SC';
}

/** CSS font stack for the preview: brand font, Noto Sans, the language's CJK family, then system fallbacks. */
export function captionFontStack(lang: string | null | undefined, brandFamily?: string | null): string {
  const quote = (f: string) => `"${f.replace(/["\\]/g, '')}"`;
  const fams = [brandFamily, DEFAULT_CAPTION_FONT, cjkFontFor(lang)].filter((f): f is string => !!f).map(quote);
  return [...fams, 'system-ui', '"Hiragino Sans"', '"PingFang SC"', '"Apple SD Gothic Neo"', '"Microsoft YaHei"', 'sans-serif'].join(', ');
}

const HEX = /^#([0-9a-f]{6})$/i;

/** Relative luminance of `#rrggbb` (WCAG). */
export function luminance(hex: string): number {
  const m = HEX.exec(hex);
  if (!m) return 1;
  const v = Number.parseInt(m[1]!, 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Text color that reads on `background`: near black on light colors, white on dark ones. */
export function readableOn(background: string): string {
  return luminance(background) > 0.4 ? '#111111' : '#FFFFFF';
}

/** A look with its colors and font settled, as the container and the preview draw it. */
export interface ResolvedCaptionLook extends CaptionLook {
  text: string;
  outlineColor: string;
  boxColor: string;
  fontFamily: string;
  /** Fallback for glyphs the font lacks (CJK). */
  cjkFamily: string;
}

export function resolveCaptionLook(style: CaptionStyleId | undefined, opts: { lang?: string | null; brandColor?: string | null; brandFont?: string | null } = {}): ResolvedCaptionLook {
  const look = CAPTION_LOOKS[style ?? 'clean'];
  const brand = opts.brandColor && HEX.test(opts.brandColor) ? opts.brandColor.toUpperCase() : null;
  let text = '#FFFFFF';
  let boxColor = '#000000';
  if (look.id === 'clean' && brand) {
    boxColor = brand;
    text = readableOn(brand);
  }
  // Bold social keeps a black outline: a dark brand color would not read on it.
  if (look.id === 'bold_social' && brand && luminance(brand) >= 0.15) text = brand;
  return {
    ...look,
    text,
    outlineColor: '#000000',
    boxColor,
    fontFamily: opts.brandFont?.trim() || DEFAULT_CAPTION_FONT,
    cjkFamily: cjkFontFor(opts.lang),
  };
}
