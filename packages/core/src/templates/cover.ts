/**
 * Preview covers of the built-in templates: a simple, on-brand picture of the
 * template's flow (its nodes laid out by column, edges between them) with its
 * title, drawn from the dark tokens of `packages/ui/tokens.css` — flat fills,
 * no gradients, no glow, no brand yellow (logo only). `apps/api/scripts/template-covers.ts`
 * rasterizes the SVG to PNG and uploads it to `public/templates/<id>/cover.png`
 * (served through the public media URL builder, D-008).
 */
import type { GraphNode } from '../graph/types';
import type { BuiltinTemplate } from './builtin';

/** Dark-theme token values (covers are images: they cannot read CSS variables). */
export const COVER_TOKENS = {
  bg: '#0B0B0C',
  surface2: '#141416',
  surface4: '#1C1C1F',
  surface5: '#26262A',
  surface6: '#2E2E33',
  border: '#1F1F23',
  text1: '#F5F5F5',
  text2: '#C8C8CC',
  text3: '#9A9AA0',
  clipVideo: '#2B3550',
  clipImage: '#243A40',
  clipVoice: '#1F3A2C',
  clipCaption: '#3B3050',
  waveVoice: '#7FD1A4',
} as const;

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** R2 key of a built-in template's cover (public bucket path). */
export function templateCoverKey(templateId: string): string {
  if (!/^tpl_[a-z0-9_]+$/.test(templateId)) throw new Error(`Not a template id: ${templateId}`);
  return `public/templates/${templateId}/cover.png`;
}

/** Cover size in pixels for a template ratio (`9:16` → 720×1280); 720 px wide. */
export function coverSize(ratio: string, width = 720): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number);
  const r = w && h && w > 0 && h > 0 ? h / w : 9 / 16;
  return { width, height: Math.round(width * r) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Shortens `s` to about `max` characters on a word boundary. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function fill(n: GraphNode): string {
  const media = n.params.media;
  if (n.kind === 'video') return COVER_TOKENS.clipVideo;
  if (n.kind === 'image') return COVER_TOKENS.clipImage;
  if (n.kind === 'asset') return media === 'audio' ? COVER_TOKENS.clipVoice : COVER_TOKENS.surface4;
  if (n.kind === 'text' || n.kind === 'script') return COVER_TOKENS.clipCaption;
  return COVER_TOKENS.surface4;
}

/** A small glyph for the node kind, centred at (cx, cy) with size s. */
function glyph(n: GraphNode, cx: number, cy: number, s: number): string {
  const c = COVER_TOKENS.text2;
  if (n.kind === 'video') {
    return `<path d="M${cx - s * 0.35} ${cy - s * 0.45} L${cx + s * 0.45} ${cy} L${cx - s * 0.35} ${cy + s * 0.45} Z" fill="${c}"/>`;
  }
  if (n.kind === 'image' || (n.kind === 'asset' && n.params.media === 'image')) {
    const w = s * 1.1;
    const h = s * 0.8;
    return (
      `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${s * 0.1}" fill="none" stroke="${c}" stroke-width="${Math.max(1.5, s * 0.08)}"/>` +
      `<path d="M${cx - w / 2 + s * 0.12} ${cy + h / 2 - s * 0.12} L${cx - s * 0.1} ${cy} L${cx + s * 0.1} ${cy + s * 0.18} L${cx + s * 0.25} ${cy + s * 0.05} L${cx + w / 2 - s * 0.12} ${cy + h / 2 - s * 0.12} Z" fill="${c}"/>`
    );
  }
  if (n.kind === 'asset' && n.params.media === 'audio') {
    const bars = [0.35, 0.8, 0.55, 1, 0.45, 0.7, 0.3];
    const gap = s * 0.2;
    const x0 = cx - ((bars.length - 1) * gap) / 2;
    return bars
      .map((b, i) => `<rect x="${x0 + i * gap - s * 0.05}" y="${cy - (b * s) / 2}" width="${s * 0.1}" height="${b * s}" rx="${s * 0.05}" fill="${COVER_TOKENS.waveVoice}"/>`)
      .join('');
  }
  // Text / script: three lines.
  return [0, 1, 2]
    .map((i) => `<rect x="${cx - s * 0.55}" y="${cy - s * 0.35 + i * s * 0.32}" width="${i === 2 ? s * 0.7 : s * 1.1}" height="${s * 0.12}" rx="${s * 0.06}" fill="${c}"/>`)
    .join('');
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The cover as an SVG document. Nodes keep their canvas layout (columns by
 * x, rows by y), scaled into the upper part; the title and the template's
 * tags sit below.
 */
export function templateCoverSvg(t: Pick<BuiltinTemplate, 'title' | 'graph' | 'meta'>, width = 720): string {
  const { height } = coverSize(t.meta.ratio, width);
  const pad = Math.round(width * 0.06);
  const titleSize = Math.round(width * 0.058);
  const metaSize = Math.round(width * 0.03);
  const footer = titleSize * 1.4 + metaSize * 2.2 + pad * 0.6;
  const area = { x: pad, y: pad, w: width - pad * 2, h: Math.max(height - pad * 2 - footer, height * 0.35) };

  const nodes = t.graph.nodes;
  const xs = [...new Set(nodes.map((n) => n.position.x))].sort((a, b) => a - b);
  const ys = [...new Set(nodes.map((n) => n.position.y))].sort((a, b) => a - b);
  const cols = Math.max(1, xs.length);
  const rows = Math.max(1, ys.length);
  const gapX = Math.round(area.w * 0.07);
  const gapY = Math.round(area.h * 0.06);
  const cellW = (area.w - gapX * (cols - 1)) / cols;
  // Generated pictures and clips keep their aspect ratio (a 9:16 template shows tall cards).
  const aspect = (n: GraphNode) => {
    const [w, h] = String(n.params.ratio ?? '').split(':').map(Number);
    return (n.kind === 'image' || n.kind === 'video') && w && h ? Math.min(1.8, Math.max(0.5, h / w)) : 0.9;
  };
  const tallest = Math.max(0.9, ...nodes.map(aspect));
  const cellH = Math.min((area.h - gapY * (rows - 1)) / rows, cellW * tallest);
  const usedH = cellH * rows + gapY * (rows - 1);
  const top = area.y + (area.h - usedH) / 2;

  const placed: Placed[] = nodes.map((node) => {
    const c = xs.indexOf(node.position.x);
    const r = ys.indexOf(node.position.y);
    const h = Math.min(cellH, cellW * aspect(node));
    return { node, x: area.x + c * (cellW + gapX), y: top + r * (cellH + gapY) + (cellH - h) / 2, w: cellW, h };
  });
  const at = new Map(placed.map((p) => [p.node.id, p]));
  const radius = Math.round(width * 0.016);
  const shortest = Math.min(...placed.map((p) => p.h));
  const label = Math.max(11, Math.round(Math.min(shortest * 0.16, width * 0.026)));
  const icon = Math.min(cellW, shortest) * 0.22;

  const edges = t.graph.edges
    .map((e) => {
      const a = at.get(e.from.node);
      const b = at.get(e.to.node);
      if (!a || !b) return '';
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      return `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${COVER_TOKENS.surface6}" stroke-width="${Math.max(1.5, width * 0.003)}"/>`;
    })
    .join('');

  const cards = placed
    .map(({ node, x, y, w, h }) => {
      const dashed = node.kind === 'asset' ? ` stroke="${COVER_TOKENS.surface6}" stroke-width="2" stroke-dasharray="6 5"` : ` stroke="${COVER_TOKENS.border}" stroke-width="1"`;
      const chars = Math.max(6, Math.floor(w / (label * 0.56)));
      return (
        `<g>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill(node)}"${dashed}/>` +
        glyph(node, x + w / 2, y + h * 0.42, icon) +
        `<text x="${x + w / 2}" y="${y + h - label * 0.9}" font-family="${FONT}" font-size="${label}" font-weight="500" fill="${COVER_TOKENS.text1}" text-anchor="middle">${esc(clip(node.title, chars))}</text>` +
        `</g>`
      );
    })
    .join('');

  const titleChars = Math.floor((width - pad * 2) / (titleSize * 0.55));
  const saysLength = t.meta.tags.slice(0, 2).some((tag) => /second/i.test(tag));
  const metaLine = [t.meta.durationSec > 0 && !saysLength ? `${t.meta.durationSec}s` : '', t.meta.ratio, ...t.meta.tags.slice(0, 2)].filter(Boolean).join(' · ');
  const titleY = height - pad - metaSize * 1.8;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${COVER_TOKENS.bg}"/>`,
    `<rect x="${pad / 2}" y="${pad / 2}" width="${width - pad}" height="${area.h + pad}" rx="${radius * 1.5}" fill="${COVER_TOKENS.surface2}"/>`,
    edges,
    cards,
    `<text x="${pad}" y="${titleY}" font-family="${FONT}" font-size="${titleSize}" font-weight="600" fill="${COVER_TOKENS.text1}">${esc(clip(t.title, titleChars))}</text>`,
    `<text x="${pad}" y="${height - pad}" font-family="${FONT}" font-size="${metaSize}" fill="${COVER_TOKENS.text3}">${esc(clip(metaLine, Math.floor((width - pad * 2) / (metaSize * 0.55))))}</text>`,
    `</svg>`,
  ].join('');
}
