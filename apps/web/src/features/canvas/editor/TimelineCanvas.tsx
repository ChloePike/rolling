import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch } from 'react';
import type { EditorProject } from './mocks';
import { PEAKS_PER_SECOND } from './peaks';
import { assetMediaUrl, posterUrl } from '@/features/overlays/backend';
import type { PlayheadStore } from './playhead';
import type { EditorAction, EditorState } from './state';
import styles from './Editor.module.css';
import { clamp, moveRange, trimRange } from '@rolling/core/timeline';
import {
  CLIP_INSET_X,
  clampPps,
  clampScroll,
  gainY,
  hitTest,
  rowLayout,
  rulerTicks,
  TAIL_SECONDS,
  thumbCount,
  timeToX,
  xToTime,
  type Row,
} from '@rolling/core/timeline';
import { applyOps } from '@rolling/core/timeline';
import type { Highlight } from '@rolling/core/timeline';
import { snapCandidates, snapMove, SNAP_PX, snapTime } from '@rolling/core/timeline';
import { formatTimecode, snapToFrame } from '@rolling/core/timeline';
import {
  clipEnd,
  edlDuration,
  findClip,
  isCaptionClip,
  type Clip,
  type Edl,
  type MediaClip,
  type TimelineOp,
  type Track,
} from '@rolling/core/timeline';

/**
 * Colors from CanvasEdit.dc.html and handoff section 2, as CSS tokens (packages/ui/tokens.css).
 * The canvas reads them with getComputedStyle and redraws when the theme changes (D-010).
 */
const TOKENS = {
  bg: '--c-tl-bg',
  rule: '--c-tl-rule',
  rulerRule: '--c-tl-ruler-rule',
  tickMajor: '--c-tl-tick-major',
  tickMinor: '--c-tl-tick-minor',
  tickLabel: '--c-tl-tick-label',
  markRange: '--c-tl-mark-range',
  playhead: '--c-tl-playhead',
  caption: '--c-clip-caption',
  voice: '--c-clip-voice',
  voiceWave: '--c-wave-voice',
  music: '--c-clip-music',
  musicWave: '--c-wave-music',
  label: '--c-tl-label',
  labelMuted: '--c-tl-label-muted',
  hatchA: '--c-tl-hatch-a',
  hatchB: '--c-tl-hatch-b',
  hatchRing: '--c-tl-hatch-ring',
  selected: '--c-tl-selected',
  envelope: '--c-tl-envelope',
  dissolveFill: '--c-tl-dissolve-fill',
  dissolveRing: '--c-tl-dissolve-ring',
  removeFill: '--c-tl-remove-fill',
  removeRing: '--c-tl-remove-ring',
  changeFill: '--c-tl-change-fill',
  changeRing: '--c-tl-change-ring',
  /** RGB triplet; the clip hairline uses it at .08 to .25 alpha. */
  hoverRgb: '--c-tl-hover-rgb',
  video1: '--c-clip-video',
  video1a: '--c-tl-video-tile-1a',
  video1b: '--c-tl-video-tile-1b',
  video1c: '--c-tl-video-tile-1c',
  video2: '--c-clip-video-2',
  video2a: '--c-tl-video-tile-2a',
  video2b: '--c-tl-video-tile-2b',
  video2c: '--c-tl-video-tile-2c',
} as const;

const C = {} as Record<keyof typeof TOKENS, string>;
/** Video clip tint and thumbnail tile shades, by the shot's order in the project. */
let VIDEO_TINTS: ReadonlyArray<{ bg: string; tiles: readonly [string, string, string] }> = [];

/** Reads the timeline colors from the root element's tokens (the active theme). */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) C[k] = cs.getPropertyValue(TOKENS[k]).trim();
  VIDEO_TINTS = [
    { bg: C.video1, tiles: [C.video1a, C.video1b, C.video1c] },
    { bg: C.video2, tiles: [C.video2a, C.video2b, C.video2c] },
  ];
}

const FONT = "'Geist', system-ui, sans-serif";
const DUR_SLOW = 320;
const DUR_BASE = 200;
const DUR_FAST = 140;
const DRAG_THRESHOLD = 3;
const DISSOLVE_MIN_PX = 28;

const easeStandard = cubicBezier(0.2, 0, 0, 1);
const easeExit = cubicBezier(0.4, 0, 1, 1);

export interface TimelineCanvasProps {
  project: EditorProject;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  playhead: PlayheadStore;
  reducedMotion: boolean;
  /** Highlights to outline (the open proposal's), or empty. */
  highlights: readonly Highlight[];
  onGenerate: (clipId: string) => void;
  onTextTool: (clipId: string) => void;
  generateLabel: (credits: number) => string;
  /** Credits to generate a shot (catalog price); defaults to the mock shot price. */
  creditsFor?: (nodeId: string) => number;
  clipName: (clip: Clip, track: Track) => string;
  clipListLabel: (clip: Clip, track: Track) => string;
  ariaLabel: string;
  clipsLabel: string;
}

interface Tween {
  from: number;
  to: number;
  t0: number;
  dur: number;
  ease: (x: number) => number;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; x0: number; scroll0: number }
  | {
      kind: 'move' | 'head' | 'tail' | 'slip';
      clipId: string;
      x0: number;
      orig: Clip;
      cands: number[];
      started: boolean;
      ops: TimelineOp[] | null;
      preview: Edl | null;
      snapAt: number | null;
    };

interface EditAnim {
  from: Map<string, { start: number; end: number }>;
  removed: Array<{ trackId: string; clip: Clip }>;
  t0: number;
  dur: number;
}

/** Tracks hover and press states on the canvas and the pointer position for the razor preview. */
interface Pointer {
  x: number;
  y: number;
  clipId: string | null;
  inside: boolean;
}

export function TimelineCanvas(props: TimelineCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const genRefs = useRef(new Map<string, HTMLButtonElement>());
  const propsRef = useRef(props);
  propsRef.current = props;

  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const raf = useRef(0);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef<Pointer>({ x: -1, y: -1, clipId: null, inside: false });
  const hover = useRef(new Map<string, Tween>());
  const editAnim = useRef<EditAnim | null>(null);
  const hlAnim = useRef<Tween>({ from: 0, to: 0, t0: 0, dur: 1, ease: easeStandard });
  const hlShown = useRef<readonly Highlight[]>([]);
  /** Timeline the highlights were computed against (before the proposal is applied). */
  const hlEdl = useRef<Edl | null>(null);
  const metrics = useRef<{ ascent11: number; line11: number; ascent10: number; digit10: number } | null>(null);

  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Clip stills by asset id (the poster variant); null when there is none. Real mode only: the mock has no media. */
  const stills = useRef(new Map<string, HTMLImageElement | null>());
  function stillFor(assetId: string | null | undefined): HTMLImageElement | null {
    const urls = propsRef.current.project.mediaUrls;
    if (!assetId || !urls) return null;
    const cache = stills.current;
    if (cache.has(assetId)) {
      const img = cache.get(assetId);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    }
    const src = posterUrl(urls[assetId] ?? assetMediaUrl(assetId));
    if (!src) {
      cache.set(assetId, null);
      return null;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => requestDraw();
    img.onerror = () => cache.set(assetId, null);
    img.src = src;
    cache.set(assetId, img);
    return null;
  }

  /** Draws `img` to fill the box, cropped to its aspect (object-fit: cover). */
  function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const sw = w / s;
    const sh = h / s;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
  }

  /* ---------- drawing ---------- */

  function frame(now: number) {
    raf.current = 0;
    const animating = draw(now);
    if (animating) requestDraw();
  }

  function tweenValue(t: Tween, now: number) {
    const p = Math.min(1, Math.max(0, (now - t.t0) / t.dur));
    return t.from + (t.to - t.from) * t.ease(p);
  }

  function draw(now: number): boolean {
    const canvas = canvasRef.current;
    const p = propsRef.current;
    if (!canvas) return false;
    const { w, h, dpr } = size.current;
    if (!w || !h) return false;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    if (!VIDEO_TINTS.length) readColors();
    if (!metrics.current) metrics.current = measureFonts(ctx);
    const m = metrics.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    let animating = false;
    const d = drag.current;
    const edl = d && 'preview' in d && d.preview ? d.preview : p.state.edl;
    const { pps, scrollX, selection, tracks: flags, marks } = p.state;
    const { rows, height: lanesH } = rowLayout(edl.tracks);
    const duration = edlDuration(edl);
    const contentRight = Math.round((duration + TAIL_SECONDS) * pps) - scrollX;
    const fps = edl.fps;

    // Edit tween (slow, standard). Reduced motion: places jump, removed clips fade.
    let editP = 1;
    const ea = editAnim.current;
    if (ea) {
      const raw = Math.min(1, (now - ea.t0) / ea.dur);
      editP = easeStandard(raw);
      if (raw < 1) animating = true;
      else editAnim.current = null;
    }
    const moveP = p.reducedMotion ? 1 : editP;

    /* Ruler */
    ctx.fillStyle = C.rulerRule;
    ctx.fillRect(0, 26, Math.max(0, contentRight), 1);
    if (marks.out > marks.in) {
      ctx.fillStyle = C.markRange;
      const x0 = timeToX(marks.in, pps, scrollX);
      ctx.fillRect(x0, 0, (marks.out - marks.in) * pps, 4);
    }
    // Markers: a small flag on the ruler (playhead color).
    ctx.fillStyle = C.playhead;
    for (const t of p.state.markers) {
      const x = Math.round(timeToX(t, pps, scrollX));
      ctx.beginPath();
      ctx.moveTo(x - 4, 4);
      ctx.lineTo(x + 4, 4);
      ctx.lineTo(x + 4, 10);
      ctx.lineTo(x, 14);
      ctx.lineTo(x - 4, 10);
      ctx.closePath();
      ctx.fill();
    }
    const { ticks } = rulerTicks(duration, pps, xToTime(-60, pps, scrollX), xToTime(w, pps, scrollX));
    ctx.font = `400 10px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    for (const t of ticks) {
      const x = Math.round(timeToX(t.t, pps, scrollX));
      ctx.fillStyle = t.major ? C.tickMajor : C.tickMinor;
      ctx.fillRect(x, t.major ? 16 : 21, 1, t.major ? 10 : 5);
      if (t.major && t.t < duration - 1e-6) {
        ctx.fillStyle = C.tickLabel;
        drawTabular(ctx, formatTimecode(t.t, fps), x + 4, 4 + m.ascent10, m.digit10);
      }
    }

    /* Row rules */
    ctx.fillStyle = C.rule;
    for (const r of rows) ctx.fillRect(0, r.top + r.height, Math.max(0, contentRight), 1);

    /* Clips */
    const nodeOrder = Object.keys(p.project.shots);
    const lookup = (trackId: string) => rows.find((r) => r.trackId === trackId)!;
    for (const track of edl.tracks) {
      const row = lookup(track.id);
      const trackAlpha = flags[track.id]?.hidden || flags[track.id]?.muted ? 0.4 : 1;
      for (const clip of track.clips as Clip[]) {
        let start = clip.start;
        let end = clipEnd(clip);
        let alpha = trackAlpha;
        const from = ea?.from.get(clip.id);
        if (ea && from) {
          start = lerp(from.start, start, moveP);
          end = lerp(from.end, end, moveP);
        } else if (ea && !from && p.reducedMotion) {
          alpha *= editP;
        }
        const hv = hover.current.get(clip.id);
        let hoverK = 0;
        if (hv) {
          hoverK = tweenValue(hv, now);
          if (now - hv.t0 < hv.dur) animating = true;
          else if (hv.to === 0) hover.current.delete(clip.id);
        }
        drawClip(ctx, m, track, clip, row, start, end, alpha, selection === clip.id, hoverK, nodeOrder);
      }
      if (ea) {
        for (const r of ea.removed) {
          if (r.trackId !== track.id) continue;
          drawClip(ctx, m, track, r.clip, row, r.clip.start, clipEnd(r.clip), trackAlpha * (1 - editP), false, 0, nodeOrder);
        }
      }
      if (track.kind === 'video') drawTransitions(ctx, track, row, ea, moveP);
    }

    /* Proposal outlines: fade in with the card (200ms), fade out on apply or discard. */
    const hl = hlAnim.current;
    const hlAlpha = tweenValue(hl, now);
    if (now - hl.t0 < hl.dur) animating = true;
    if (hlAlpha > 0.001) {
      ctx.save();
      ctx.globalAlpha = hlAlpha;
      for (const h of hlShown.current) {
        const ref = findClip(hlEdl.current ?? edl, h.clipId);
        if (!ref) continue;
        const row = lookup(ref.track.id);
        const x = timeToX(h.from, pps, scrollX);
        const wpx = (h.to - h.from) * pps;
        const atStart = Math.abs(h.from - ref.clip.start) < 1e-6;
        const atEnd = Math.abs(h.to - clipEnd(ref.clip)) < 1e-6;
        const radii = [atStart ? 4 : 0, atEnd ? 4 : 0, atEnd ? 4 : 0, atStart ? 4 : 0];
        const y = row.top + 3;
        const hh = row.height - 6;
        ctx.beginPath();
        ctx.roundRect(x, y, wpx, hh, radii);
        ctx.fillStyle = h.kind === 'remove' ? C.removeFill : C.changeFill;
        ctx.fill();
        insetRing(ctx, x, y, wpx, hh, radii, 1, h.kind === 'remove' ? C.removeRing : C.changeRing);
      }
      ctx.restore();
    }

    /* Snap guide while dragging */
    if (d && 'snapAt' in d && d.snapAt !== null && d.started) {
      ctx.fillStyle = C.playhead;
      ctx.fillRect(Math.round(timeToX(d.snapAt, pps, scrollX)), 27, 1, lanesH - 27);
    }

    /* Razor preview */
    const pt = pointer.current;
    if (p.state.tool === 'razor' && pt.inside && pt.clipId && !d) {
      const t = razorTime(pt.x);
      ctx.save();
      ctx.strokeStyle = C.selected;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      const x = Math.round(timeToX(t, pps, scrollX)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 27);
      ctx.lineTo(x, lanesH);
      ctx.stroke();
      ctx.restore();
    }

    /* Playhead: 12x14 head on the ruler, 1px line to the last row. */
    const px = timeToX(p.playhead.time, pps, scrollX);
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 6, 14 * 0.6);
    ctx.lineTo(px, 14);
    ctx.lineTo(px - 6, 14 * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(Math.round(px - 0.5), 12, 1, lanesH - 12);

    placeGenerateButtons(edl, rows, m, ea, moveP);
    return animating;
  }

  function drawClip(
    ctx: CanvasRenderingContext2D,
    m: NonNullable<typeof metrics.current>,
    track: Track,
    clip: Clip,
    row: Row,
    start: number,
    end: number,
    alpha: number,
    selected: boolean,
    hoverK: number,
    nodeOrder: string[],
  ) {
    const p = propsRef.current;
    const { pps, scrollX } = p.state;
    const x = timeToX(start, pps, scrollX) + CLIP_INSET_X;
    const w = (end - start) * pps - CLIP_INSET_X * 2;
    const y = row.top + 3;
    const h = row.height - 6;
    if (w <= 0 || x > size.current.w || x + w < 0 || alpha <= 0) return;
    const media = isCaptionClip(clip) ? null : clip;
    const notGenerated = track.kind === 'video' && media?.assetId === null;
    const tint = VIDEO_TINTS[Math.max(0, nodeOrder.indexOf(media?.nodeId ?? '')) % VIDEO_TINTS.length]!;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.clip();

    // Inset ring (box-shadow inset paints under the clip's content): 1.5px white when
    // selected, 1px hairline otherwise, brighter on hover.
    const ring = () => {
      if (selected) insetRing(ctx, x, y, w, h, 4, 1.5, C.selected);
      else if (notGenerated) insetRing(ctx, x, y, w, h, 4, 1, C.hatchRing);
      else insetRing(ctx, x, y, w, h, 4, 1, `rgba(${C.hoverRgb},${(0.08 + 0.17 * hoverK).toFixed(3)})`);
    };

    if (notGenerated) {
      ctx.fillStyle = C.hatchA;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = C.hatchB;
      const step = 12 * Math.SQRT2;
      for (let c0 = 6 * Math.SQRT2; c0 < w + h; c0 += step) {
        const c1 = c0 + 6 * Math.SQRT2;
        ctx.beginPath();
        ctx.moveTo(x + c0, y);
        ctx.lineTo(x + c1, y);
        ctx.lineTo(x + c1 - h, y + h);
        ctx.lineTo(x + c0 - h, y + h);
        ctx.closePath();
        ctx.fill();
      }
      ring();
      const block = m.line11 + 4 + 22;
      const top = y + (h - block) / 2;
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = C.labelMuted;
      ctx.fillText(p.clipName(clip, track), x + 8, top + m.ascent11);
    } else {
      ctx.fillStyle = track.kind === 'caption' ? C.caption : track.kind === 'voice' ? C.voice : track.kind === 'music' ? C.music : tint.bg;
      ctx.fillRect(x, y, w, h);
      ring();
      if (track.kind === 'video') {
        const n = thumbCount(w);
        const tw = (w - (n - 1)) / n;
        // The shot's poster in each tile once it has loaded; the tinted tiles until then (and in the mock).
        const still = stillFor(media?.assetId);
        for (let i = 0; i < n; i++) {
          const a = Math.round(x + i * (tw + 1));
          const b = Math.round(x + i * (tw + 1) + tw);
          ctx.fillStyle = tint.tiles[i % 3]!;
          ctx.fillRect(a, y + 20, b - a, h - 20);
          if (still) drawCover(ctx, still, a, y + 20, b - a, h - 20);
        }
      }
      if (media && (track.kind === 'voice' || track.kind === 'music')) {
        drawWave(ctx, media, x, y, w, h, track.kind === 'voice' ? C.voiceWave : C.musicWave, track.kind === 'music' ? 0.8 : 1);
        if (media.gainKeyframes?.length) drawEnvelope(ctx, media, x, y, end - start);
      }
      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = C.label;
      ctx.fillText(p.clipName(clip, track), x + 6, y + 4 + m.ascent11);
    }

    ctx.restore();
  }

  function drawWave(ctx: CanvasRenderingContext2D, clip: MediaClip, x: number, y: number, w: number, _h: number, color: string, opacity: number) {
    const info = clip.assetId ? propsRef.current.project.audio[clip.assetId] : undefined;
    if (!info || !info.peaks.length) return;
    const { pps } = propsRef.current.state;
    const left = x + 4;
    const boxW = w - 8;
    const cy = y + 16 + 15;
    ctx.save();
    ctx.globalAlpha *= opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const visibleFrom = Math.max(0, Math.floor((-left - 3) / 3));
    const visibleTo = Math.min(Math.ceil(boxW / 3), Math.ceil((size.current.w - left) / 3) + 1);
    for (let i = visibleFrom; i < visibleTo; i++) {
      const bx = 1.5 + 3 * i;
      if (bx >= boxW) break;
      const src = clip.in + (3 * i) / pps;
      const idx = Math.floor(src * PEAKS_PER_SECOND + 1e-6) % info.peaks.length;
      const a = info.peaks[idx]! / 10;
      ctx.moveTo(left + bx, cy - a);
      ctx.lineTo(left + bx, cy + a);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawEnvelope(ctx: CanvasRenderingContext2D, clip: MediaClip, x: number, y: number, dur: number) {
    const { pps } = propsRef.current.state;
    const kfs = clip.gainKeyframes!;
    const ox = x - CLIP_INSET_X;
    const oy = y;
    ctx.save();
    ctx.globalAlpha *= 0.7;
    ctx.strokeStyle = C.envelope;
    ctx.lineWidth = 1;
    ctx.beginPath();
    kfs.forEach((k, i) => {
      const px = ox + k.t * pps;
      const py = oy + gainY(k.db);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.envelope;
    for (const k of kfs) {
      if (k.t <= 1e-6 || k.t >= dur - 1e-6) continue;
      ctx.beginPath();
      ctx.arc(ox + k.t * pps, oy + gainY(k.db), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTransitions(ctx: CanvasRenderingContext2D, track: Track, row: Row, ea: EditAnim | null, moveP: number) {
    const { pps, scrollX } = propsRef.current.state;
    for (const clip of track.clips as MediaClip[]) {
      if (!clip.transitionOut) continue;
      let end = clipEnd(clip);
      const from = ea?.from.get(clip.id);
      if (from) end = lerp(from.end, end, moveP);
      const wpx = Math.max(DISSOLVE_MIN_PX, clip.transitionOut.dur * pps);
      const x = timeToX(end, pps, scrollX) - wpx / 2;
      const y = row.top + 22;
      const hh = row.height - 28;
      ctx.beginPath();
      ctx.roundRect(x, y, wpx, hh, 3);
      ctx.fillStyle = C.dissolveFill;
      ctx.fill();
      insetRing(ctx, x, y, wpx, hh, 3, 1, C.dissolveRing);
    }
  }

  function placeGenerateButtons(edl: Edl, rows: Row[], m: NonNullable<typeof metrics.current>, ea: EditAnim | null, moveP: number) {
    const { pps, scrollX } = propsRef.current.state;
    for (const [id, el] of genRefs.current) {
      const ref = findClip(edl, id);
      if (!ref) {
        el.style.visibility = 'hidden';
        continue;
      }
      const row = rows.find((r) => r.trackId === ref.track.id)!;
      let start = ref.clip.start;
      const from = ea?.from.get(id);
      if (from) start = lerp(from.start, start, moveP);
      const x = timeToX(start, pps, scrollX) + CLIP_INSET_X + 8;
      const h = row.height - 6;
      const block = m.line11 + 4 + 22;
      const y = row.top + 3 + (h - block) / 2 + m.line11 + 4;
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.visibility = 'visible';
    }
  }

  /* ---------- interaction ---------- */

  function local(e: { clientX: number; clientY: number }) {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function razorTime(x: number) {
    const p = propsRef.current;
    const t = xToTime(x, p.state.pps, p.state.scrollX);
    if (!p.state.snapping) return snapToFrame(t, p.state.edl.fps);
    const s = snapTime(t, [p.playhead.time], SNAP_PX / p.state.pps);
    return s.target !== null ? s.time : snapToFrame(t, p.state.edl.fps);
  }

  function sourceDuration(clip: MediaClip) {
    const p = propsRef.current.project;
    if (!clip.assetId && clip.nodeId) return p.shots[clip.nodeId]?.seconds;
    if (clip.assetId && p.audio[clip.assetId]) return p.audio[clip.assetId]!.seconds;
    const shot = clip.nodeId ? p.shots[clip.nodeId] : undefined;
    return shot?.seconds;
  }

  function seekTo(x: number) {
    const p = propsRef.current;
    let t = xToTime(x, p.state.pps, p.state.scrollX);
    if (p.state.snapping) {
      const s = snapTime(t, snapCandidates(p.state.edl), SNAP_PX / p.state.pps);
      t = s.target !== null ? s.time : t;
    }
    p.playhead.seek(snapToFrame(Math.max(0, t), p.state.edl.fps));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const p = propsRef.current;
    const { x, y } = local(e);
    wrapRef.current!.focus({ preventScroll: true });
    const { rows } = rowLayout(p.state.edl.tracks);
    const hit = hitTest(p.state.edl, rows, p.state.pps, p.state.scrollX, x, y);
    e.currentTarget.setPointerCapture(e.pointerId);

    if (p.state.tool === 'hand' || e.button === 1) {
      drag.current = { kind: 'pan', x0: x, scroll0: p.state.scrollX };
      setCursor('grabbing');
      return;
    }
    if (hit.kind === 'ruler') {
      drag.current = { kind: 'scrub' };
      seekTo(x);
      return;
    }
    if (hit.kind !== 'clip') {
      p.dispatch({ type: 'select', clipId: null });
      return;
    }
    const ref = findClip(p.state.edl, hit.clipId)!;
    const locked = p.state.tracks[hit.trackId]?.locked;
    if (p.state.tool === 'razor') {
      if (!locked) p.dispatch({ type: 'commit', ops: [{ op: 'split', clipId: hit.clipId, at: razorTime(x) }], animate: true });
      return;
    }
    p.dispatch({ type: 'select', clipId: hit.clipId });
    if (p.state.tool === 'text') {
      if (isCaptionClip(ref.clip)) p.onTextTool(hit.clipId);
      return;
    }
    if (locked) return;
    const kind = p.state.tool === 'slip' ? (isCaptionClip(ref.clip) ? null : 'slip') : hit.zone === 'body' ? 'move' : hit.zone;
    if (!kind) return;
    const cands = snapCandidates(p.state.edl, { playhead: p.playhead.time, exclude: hit.clipId });
    cands.push(p.state.marks.in, p.state.marks.out, ...p.state.markers);
    drag.current = { kind, clipId: hit.clipId, x0: x, orig: ref.clip, cands, started: false, ops: null, preview: null, snapAt: null };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = propsRef.current;
    const { x, y } = local(e);
    const d = drag.current;
    pointer.current.x = x;
    pointer.current.y = y;
    if (!d) {
      updateHover(x, y);
      return;
    }
    if (d.kind === 'scrub') {
      seekTo(x);
      return;
    }
    if (d.kind === 'pan') {
      const duration = edlDuration(p.state.edl);
      p.dispatch({ type: 'view', scrollX: clampScroll(d.scroll0 - (x - d.x0), duration, p.state.pps, size.current.w) });
      return;
    }
    if (!d.started && Math.abs(x - d.x0) < DRAG_THRESHOLD) return;
    d.started = true;
    const { pps, edl, snapping } = p.state;
    const fps = edl.fps;
    const dt = (x - d.x0) / pps;
    const threshold = snapping ? SNAP_PX / pps : 0;
    const o = d.orig;
    const oEnd = clipEnd(o);
    let ops: TimelineOp[] = [];
    let snapAt: number | null = null;
    const snapOne = (t: number) => {
      const s = snapping ? snapTime(t, d.cands, threshold) : { time: t, target: null };
      snapAt = s.target;
      return s.target !== null ? s.time : snapToFrame(t, fps);
    };
    if (d.kind === 'move') {
      const s = snapping ? snapMove(o.start + dt, oEnd - o.start, d.cands, threshold) : { time: o.start + dt, target: null };
      snapAt = s.target;
      let start = s.target !== null ? s.time : snapToFrame(o.start + dt, fps);
      const range = moveRange(edl, o.id)!;
      start = clamp(start, range);
      if (snapAt !== null && Math.abs(start - s.time) > 1e-6) snapAt = null;
      ops = [{ op: 'move', clipId: o.id, start }];
    } else if (d.kind === 'head') {
      const range = trimRange(edl, o.id, 'start')!;
      const t = clamp(snapOne(o.start + dt), range);
      ops = [isCaptionClip(o) ? { op: 'trim', clipId: o.id, in: t } : { op: 'trim', clipId: o.id, in: round(o.in + (t - o.start)) }];
    } else if (d.kind === 'tail') {
      const range = trimRange(edl, o.id, 'end', isCaptionClip(o) ? undefined : sourceDuration(o))!;
      const t = clamp(snapOne(oEnd + dt), range);
      ops = [isCaptionClip(o) ? { op: 'trim', clipId: o.id, out: t } : { op: 'trim', clipId: o.id, out: round(o.in + (t - o.start)) }];
    } else if (d.kind === 'slip' && !isCaptionClip(o)) {
      const len = o.out - o.in;
      const src = sourceDuration(o) ?? o.out;
      const newIn = Math.min(Math.max(0, snapToFrame(o.in - dt, fps)), Math.max(0, src - len));
      ops = [
        { op: 'trim', clipId: o.id, in: round(newIn), out: round(newIn + len) },
        { op: 'move', clipId: o.id, start: o.start },
      ];
    }
    const result = applyOps(edl, ops, { sourceDuration });
    if (result.ok) {
      d.ops = ops;
      d.preview = result.edl;
      d.snapAt = snapAt;
    }
    requestDraw();
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && 'ops' in d && d.started && d.ops) {
      propsRef.current.dispatch({ type: 'commit', ops: d.ops, animate: false });
    }
    const { x, y } = local(e);
    updateHover(x, y);
    requestDraw();
  }

  function setCursor(c: string) {
    if (wrapRef.current && wrapRef.current.style.cursor !== c) wrapRef.current.style.cursor = c;
  }

  function updateHover(x: number, y: number) {
    const p = propsRef.current;
    const { rows } = rowLayout(p.state.edl.tracks);
    const hit = hitTest(p.state.edl, rows, p.state.pps, p.state.scrollX, x, y);
    const clipId = hit.kind === 'clip' ? hit.clipId : null;
    pointer.current = { x, y, clipId, inside: true };
    const tool = p.state.tool;
    setCursor(
      tool === 'hand'
        ? 'grab'
        : hit.kind === 'ruler'
          ? 'pointer'
          : hit.kind !== 'clip'
            ? 'default'
            : tool === 'razor'
              ? 'crosshair'
              : tool === 'text'
                ? 'text'
                : tool === 'slip'
                  ? 'ew-resize'
                  : hit.zone === 'body'
                    ? 'default'
                    : hit.zone === 'head'
                      ? 'w-resize'
                      : 'e-resize',
    );
    setHover(clipId);
    requestDraw();
  }

  const hovered = useRef<string | null>(null);
  function setHover(clipId: string | null) {
    if (hovered.current === clipId) return;
    const now = performance.now();
    const map = hover.current;
    const fade = (id: string, to: number) => {
      const prev = map.get(id);
      const from = prev ? tweenValue(prev, now) : 0;
      // Hover in 140ms standard; hover out uses the exit curve.
      map.set(id, { from, to, t0: now, dur: DUR_FAST, ease: to ? easeStandard : easeExit });
    };
    if (hovered.current) fade(hovered.current, 0);
    if (clipId) fade(clipId, 1);
    hovered.current = clipId;
  }

  function onPointerLeave() {
    if (drag.current) return;
    pointer.current.inside = false;
    setHover(null);
    requestDraw();
  }

  /* ---------- effects ---------- */

  // Size and devicePixelRatio.
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      size.current = { w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
      requestDraw();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    const onDpr = () => {
      measure();
      watchDpr();
    };
    watchDpr();
    return () => {
      ro.disconnect();
      mq?.removeEventListener('change', onDpr);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [requestDraw]);

  // Follow the theme (D-010): system changes and the data-theme override both re-read the tokens.
  useEffect(() => {
    const onTheme = () => {
      readColors();
      requestDraw();
    };
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener?.('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq?.removeEventListener?.('change', onTheme);
      mo.disconnect();
    };
  }, [requestDraw]);

  // Redraw when fonts arrive (labels are measured once they are loaded).
  useEffect(() => {
    let alive = true;
    void Promise.all([document.fonts.load(`600 11px ${FONT}`), document.fonts.load(`400 10px ${FONT}`)]).then(() => {
      if (!alive) return;
      metrics.current = null;
      requestDraw();
    });
    return () => {
      alive = false;
    };
  }, [requestDraw]);

  // Follow the playhead; page the view while playing.
  useEffect(() => {
    const store = props.playhead;
    return store.subscribe(() => {
      const p = propsRef.current;
      if (store.playing) {
        const x = timeToX(store.time, p.state.pps, p.state.scrollX);
        const w = size.current.w;
        if (x > w - 40 || x < 0) {
          const duration = edlDuration(p.state.edl);
          p.dispatch({ type: 'view', scrollX: clampScroll(store.time * p.state.pps - 40, duration, p.state.pps, w) });
        }
      }
      requestDraw();
    });
  }, [props.playhead, requestDraw]);

  // Start the slow tween when the timeline changes from a command (not a drag).
  const lastVersion = useRef(props.state.change.version);
  useLayoutEffect(() => {
    const { change, edl } = props.state;
    if (change.version === lastVersion.current) return;
    lastVersion.current = change.version;
    if (!change.animate || !change.previous) {
      editAnim.current = null;
      return;
    }
    const from = new Map<string, { start: number; end: number }>();
    const removed: EditAnim['removed'] = [];
    for (const track of change.previous.tracks) {
      for (const c of track.clips as Clip[]) {
        from.set(c.id, { start: c.start, end: clipEnd(c) });
        if (!findClip(edl, c.id)) removed.push({ trackId: track.id, clip: c });
      }
    }
    editAnim.current = { from, removed, t0: performance.now(), dur: props.reducedMotion ? DUR_BASE : DUR_SLOW };
    requestDraw();
  }, [props.state, props.reducedMotion, requestDraw]);

  // Proposal outlines fade in with the card and out when it closes.
  const hlKey = props.highlights.map((h) => `${h.clipId}:${h.from}:${h.to}`).join('|');
  useLayoutEffect(() => {
    const now = performance.now();
    const current = tweenValue(hlAnim.current, now);
    if (props.highlights.length) {
      hlShown.current = props.highlights;
      hlEdl.current = props.state.edl;
      hlAnim.current = { from: current, to: 1, t0: now, dur: DUR_BASE, ease: easeStandard };
    } else {
      // Fade out over the slow edit so the outline disappears as the clip shrinks.
      hlAnim.current = { from: current, to: 0, t0: now, dur: DUR_SLOW, ease: easeExit };
    }
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlKey, requestDraw]);

  // Any other prop change redraws.
  useEffect(() => {
    requestDraw();
  });

  // Wheel: ctrl/cmd zooms around the pointer, otherwise scrolls horizontally.
  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      const p = propsRef.current;
      e.preventDefault();
      const duration = edlDuration(p.state.edl);
      const { x } = local(e);
      if (e.ctrlKey || e.metaKey) {
        const t = xToTime(x, p.state.pps, p.state.scrollX);
        const pps = clampPps(p.state.pps * Math.exp(-e.deltaY * 0.0025));
        p.dispatch({ type: 'view', pps, scrollX: clampScroll(t * pps - x, duration, pps, size.current.w) });
      } else {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        p.dispatch({ type: 'view', scrollX: clampScroll(p.state.scrollX + delta, duration, p.state.pps, size.current.w) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---------- render ---------- */

  const { edl, selection, running } = props.state;
  const pending: Array<{ clip: MediaClip; track: Track }> = [];
  for (const track of edl.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) if (clip.assetId === null) pending.push({ clip, track });
  }

  return (
    <div
      ref={wrapRef}
      className={styles.lanes}
      role="group"
      aria-label={props.ariaLabel}
      tabIndex={0}
      data-testid="timeline-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={canvasRef} className={styles.lanesCanvas} aria-hidden="true" />
      <div className={styles.laneOverlay}>
        {pending.map(({ clip }) => {
          const credits = clip.nodeId ? (props.creditsFor?.(clip.nodeId) ?? props.project.shots[clip.nodeId]?.credits ?? 0) : 0;
          const busy = running.includes(clip.id);
          return (
            <button
              key={clip.id}
              ref={(el) => {
                if (el) genRefs.current.set(clip.id, el);
                else genRefs.current.delete(clip.id);
              }}
              type="button"
              className={styles.generateButton}
              style={{ visibility: 'hidden' }}
              disabled={busy}
              aria-busy={busy || undefined}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => props.onGenerate(clip.id)}
            >
              {props.generateLabel(credits)}
            </button>
          );
        })}
      </div>
      <ul className="rl-visually-hidden" aria-label={props.clipsLabel}>
        {edl.tracks.flatMap((track) =>
          (track.clips as Clip[]).map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                aria-pressed={selection === clip.id}
                data-clip-id={clip.id}
                onClick={() => props.dispatch({ type: 'select', clipId: clip.id })}
              >
                {props.clipListLabel(clip, track)}
              </button>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

/* ---------- helpers ---------- */

function measureFonts(ctx: CanvasRenderingContext2D) {
  ctx.font = `600 11px ${FONT}`;
  const t11 = ctx.measureText('Hg');
  ctx.font = `400 10px ${FONT}`;
  const t10 = ctx.measureText('Hg');
  return {
    ascent11: Math.round(t11.fontBoundingBoxAscent),
    line11: Math.round(t11.fontBoundingBoxAscent + t11.fontBoundingBoxDescent),
    ascent10: Math.round(t10.fontBoundingBoxAscent),
    digit10: tabularDigitWidth(10),
  };
}

/** Canvas text has no tabular figures; measure the tabular digit advance from the DOM (once per font load). */
function tabularDigitWidth(px: number): number {
  const span = document.createElement('span');
  span.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:400 ${px}px ${FONT};font-variant-numeric:tabular-nums`;
  span.textContent = '0123456789'.repeat(4);
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width / 40;
  span.remove();
  return w;
}

/** Draws text with digits on a fixed advance, centering each digit in its cell like tabular figures. */
function drawTabular(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, digit: number) {
  let cx = x;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      const w = ctx.measureText(ch).width;
      ctx.fillText(ch, cx + (digit - w) / 2, y);
      cx += digit;
    } else {
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width;
    }
  }
}

/** Ring drawn inside a rounded rect, like `box-shadow: inset 0 0 0 <w>px <color>`. */
function insetRing(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[], lw: number, color: string) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  ctx.lineWidth = lw * 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function lerp(a: number, b: number, p: number) {
  return a + (b - a) * p;
}

function round(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

/** CSS cubic-bezier timing function. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sx(t) - x;
      const d = dx(t);
      if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
