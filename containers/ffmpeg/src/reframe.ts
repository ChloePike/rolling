/**
 * Smart reframe (D-027): where the main subject is in a clip, from small
 * grayscale frames sampled by ffmpeg, as a smooth path the crop window follows.
 * Pure (no I/O), so the server and the tests share it.
 *
 * Saliency per frame: edge energy (local contrast) plus motion against the
 * previous sample (moving things are usually the subject), weighted by a soft
 * center prior; the focus is the centroid of the strongest 12% of cells.
 * The path is smoothed both ways (no lag), held still inside a dead zone and
 * speed-limited, so the camera pans gently instead of jittering.
 * We do not call a paid face-detection model for this: the saliency tracker
 * is free and runs next to the render.
 */

export const ANALYSIS = { width: 64, height: 64, fps: 3 } as const;

export interface FocusSample {
  t: number;
  x: number;
  y: number;
  /** How clear the subject is (0..1); low weights lean on the neighbours. */
  w: number;
}

export interface FocusKey {
  t: number;
  x: number;
  y: number;
}

/** ffmpeg arguments: `len` seconds from `start` of a URL as raw 64×64 gray frames at 3 fps, to stdout. */
export function analysisArgs(url: string, start: number, len: number): string[] {
  return [
    "-v", "error",
    ...(/^https?:/.test(url) ? ["-reconnect", "1", "-reconnect_on_network_error", "1"] : []),
    "-ss", start.toFixed(3), "-t", Math.max(0.1, len).toFixed(3),
    "-i", url,
    "-an", "-sn",
    "-vf", `fps=${ANALYSIS.fps},scale=${ANALYSIS.width}:${ANALYSIS.height}:flags=area,format=gray`,
    "-f", "rawvideo", "pipe:1",
  ];
}

/** Splits raw gray bytes into frames. */
export function splitFrames(buf: Uint8Array, width = ANALYSIS.width, height = ANALYSIS.height): Uint8Array[] {
  const size = width * height;
  const out: Uint8Array[] = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
}

/** Focus of one frame (normalised 0..1), with a confidence weight. */
export function frameFocus(frame: Uint8Array, prev: Uint8Array | null, width = ANALYSIS.width, height = ANALYSIS.height): { x: number; y: number; w: number } {
  const sal = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = frame[i + 1]! - frame[i - 1]!;
      const gy = frame[i + width]! - frame[i - width]!;
      const edge = Math.sqrt(gx * gx + gy * gy);
      const motion = prev ? Math.abs(frame[i]! - prev[i]!) : 0;
      const dx = x / width - 0.5;
      const dy = y / height - 0.5;
      const prior = Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
      sal[i] = (0.6 * edge + 1.6 * motion) * (0.35 + 0.65 * prior);
    }
  }
  const sorted = Array.from(sal).sort((a, b) => b - a);
  const cut = sorted[Math.floor(sorted.length * 0.12)] ?? 0;
  const top = sorted[0] ?? 0;
  if (top <= 1e-6) return { x: 0.5, y: 0.5, w: 0 };
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = sal[y * width + x]!;
      if (v < cut || v <= 0) continue;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
      sw += v;
    }
  }
  if (sw <= 0) return { x: 0.5, y: 0.5, w: 0 };
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  // A peaked map (one clear subject) is trusted more than a flat one.
  const w = Math.min(1, Math.max(0, (cut - mean) / (top + 1e-6) * 3));
  return { x: sx / sw / width, y: sy / sw / height, w };
}

/** Focus samples of a clip's frames at `1 / fps` spacing from `t0`. */
export function focusSamples(frames: readonly Uint8Array[], t0 = 0, fps: number = ANALYSIS.fps): FocusSample[] {
  return frames.map((f, i) => ({ t: t0 + i / fps, ...frameFocus(f, i > 0 ? frames[i - 1]! : null) }));
}

export interface SmoothOptions {
  /** Ignore moves smaller than this share of the frame. */
  deadZone?: number;
  /** Largest pan speed, frame widths per second. */
  maxSpeed?: number;
  /** Most keys in the output (the crop expression grows with each). */
  maxKeys?: number;
}

/**
 * A smooth focus path from samples: confidence-weighted, zero-phase smoothed,
 * dead-zoned and speed-limited, reduced to at most `maxKeys` keys.
 */
export function smoothPath(samples: readonly FocusSample[], opts: SmoothOptions = {}): FocusKey[] {
  const deadZone = opts.deadZone ?? 0.04;
  const maxSpeed = opts.maxSpeed ?? 0.25;
  const maxKeys = opts.maxKeys ?? 16;
  if (!samples.length) return [{ t: 0, x: 0.5, y: 0.5 }];
  // Low-confidence samples lean toward the center.
  const pts = samples.map((s) => ({ t: s.t, x: 0.5 + (s.x - 0.5) * (0.3 + 0.7 * s.w), y: 0.5 + (s.y - 0.5) * (0.3 + 0.7 * s.w) }));
  const ema = (vals: number[], a: number) => {
    const fwd = [...vals];
    for (let i = 1; i < fwd.length; i++) fwd[i] = a * fwd[i]! + (1 - a) * fwd[i - 1]!;
    for (let i = fwd.length - 2; i >= 0; i--) fwd[i] = a * fwd[i]! + (1 - a) * fwd[i + 1]!;
    return fwd;
  };
  const xs = ema(pts.map((p) => p.x), 0.35);
  const ys = ema(pts.map((p) => p.y), 0.35);
  const out: FocusKey[] = [];
  let cx = xs[0]!;
  let cy = ys[0]!;
  for (let i = 0; i < pts.length; i++) {
    const dt = i === 0 ? 0 : pts[i]!.t - pts[i - 1]!.t;
    let tx = xs[i]!;
    let ty = ys[i]!;
    if (Math.abs(tx - cx) < deadZone) tx = cx;
    if (Math.abs(ty - cy) < deadZone) ty = cy;
    const lim = maxSpeed * dt;
    if (i > 0) {
      tx = cx + Math.max(-lim, Math.min(lim, tx - cx));
      ty = cy + Math.max(-lim, Math.min(lim, ty - cy));
    }
    cx = Math.min(1, Math.max(0, tx));
    cy = Math.min(1, Math.max(0, ty));
    out.push({ t: round(pts[i]!.t), x: round(cx), y: round(cy) });
  }
  return reduceKeys(out, maxKeys);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Drops keys that a straight line through their neighbours already gives (then evenly, past `max`). */
export function reduceKeys(keys: readonly FocusKey[], max: number): FocusKey[] {
  if (keys.length <= 2) return [...keys];
  const kept: FocusKey[] = [keys[0]!];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = kept[kept.length - 1]!;
    const b = keys[i]!;
    const c = keys[i + 1]!;
    const f = (b.t - a.t) / (c.t - a.t || 1);
    const ex = a.x + (c.x - a.x) * f;
    const ey = a.y + (c.y - a.y) * f;
    if (Math.abs(ex - b.x) > 0.005 || Math.abs(ey - b.y) > 0.005) kept.push(b);
  }
  kept.push(keys[keys.length - 1]!);
  if (kept.length <= max) return kept;
  const step = (kept.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => kept[Math.round(i * step)]!);
}

/**
 * Source-time samples to clip-local time (what the crop expression's `t` is):
 * speed divides, reverse runs from the out point.
 */
export function toClipTime(keys: readonly FocusKey[], clip: { in: number; out: number; speed?: number; reverse?: boolean }): FocusKey[] {
  const speed = clip.speed ?? 1;
  const mapped = keys.map((k) => ({ ...k, t: round((clip.reverse ? clip.out - (clip.in + k.t) : k.t) / speed) }));
  return mapped.sort((a, b) => a.t - b.t);
}
