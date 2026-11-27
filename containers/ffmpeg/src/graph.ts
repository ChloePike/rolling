/**
 * Filter-graph builder for `/render` (pure: no I/O). Turns an EDL (the
 * `@rolling/core/timeline` format, copied here because the container builds
 * from its own directory) into ffmpeg arguments and an ASS subtitle file.
 *
 * Video: each video track is a chain of segments (clips and black gaps) joined
 * with `concat`, or with `xfade` where a clip has `transitionOut` and the next
 * clip follows without a gap (the cut stays where it is: both sides get half
 * the transition as a frozen-frame handle). A clip is trimmed (input `-ss`/`-t`),
 * reversed, retimed (`setpts`), resampled to the output rate, scaled to fit and
 * padded to the frame; a transform scales, rotates, fades the alpha and places
 * it on a canvas with `overlay`; `fadeIn` fades from black. The first video
 * track is opaque; later tracks are transparent layers overlaid on top.
 * Captions burn in with `ass` at their exact times.
 *
 * Audio: every media clip with sound (voice, music, and video clips whose
 * file has audio) is trimmed, reversed (`areverse`), retimed (`atempo` chain),
 * given its gain or keyframed gain (`volume` with a per-frame expression, dB
 * interpolated linearly like the editor's `gainAt`), faded in and delayed to
 * its start. Clips mix into one bus per track (`amix`, no normalisation); a
 * track whose clips list `duckUnder` is compressed by those tracks
 * (`sidechaincompress`). Buses mix into the output, padded to the duration.
 */

export interface Transition {
  type: "dissolve";
  dur: number;
}
export interface GainKeyframe {
  t: number;
  db: number;
}
export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
}
export interface CaptionClip {
  id: string;
  start: number;
  end: number;
  text: string;
}
export interface MediaClip {
  id: string;
  assetId: string | null;
  nodeId?: string;
  in: number;
  out: number;
  start: number;
  transitionOut?: Transition;
  gainDb?: number;
  duckUnder?: string[];
  gainKeyframes?: GainKeyframe[];
  fadeIn?: number;
  transform?: ClipTransform;
  speed?: number;
  reverse?: boolean;
  reframe?: { mode: "auto" | "center" | "manual"; x?: number; y?: number };
}
export type Track =
  | { id: string; kind: "caption"; clips: CaptionClip[]; style?: string; lang?: string }
  | { id: string; kind: "video" | "voice" | "music"; clips: MediaClip[] };
export interface Edl {
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
}

/** What the Worker sends (`RenderJob` in `@rolling/core/export`). */
export interface RenderJob {
  id: string;
  edl: Edl;
  width: number;
  height: number;
  fps: number;
  duration: number;
  inputs: Record<string, { url: string }>;
  putUrl?: string;
  encode?: EncodeSettings;
  reframe?: boolean;
  interpolateFps?: 48 | 60;
  /** Resolved caption look; null = no burn-in; absent = the default look. */
  captions?: RenderCaptions | null;
  fonts?: { family: string; url: string; format: "woff2" | "ttf" | "otf" }[];
  brand?: RenderBrand;
  audioOnly?: { sampleRate: 16000; chunkSeconds: number };
  voiceLufs?: number;
}

/** `EncodeSettings` in `@rolling/core/export`. */
export interface EncodeSettings {
  crf: number | null;
  videoKbps: number | null;
  maxKbps: number | null;
  bufferKbps: number | null;
  profile: "high";
  level: "4.1" | "4.2";
  audioKbps: number;
  loudnessLufs: number | null;
  truePeakDb: number;
}

/** `ResolvedCaptionLook` in `@rolling/core/post` (colors `#RRGGBB`). */
export interface CaptionLook {
  id: string;
  weight: number;
  size: number;
  outline: number;
  box: { opacity: number } | null;
  shadow: boolean;
  marginV: number;
  maxLines: number;
  text: string;
  outlineColor: string;
  boxColor: string;
  fontFamily: string;
  cjkFamily: string;
}
export interface RenderCaptions {
  look: CaptionLook;
  lang: string | null;
}
export interface RenderCard {
  seconds: number;
  background: string;
  color: string;
  text: string;
  fontFamily?: string;
  logoUrl?: string;
}
export interface RenderBrand {
  watermark?: { url: string; position: "top_left" | "top_right" | "bottom_left" | "bottom_right"; opacity: number; size: number };
  intro?: RenderCard;
  outro?: RenderCard;
}

/** Subject path of a reframed clip: focus point (0..1 of the source frame) at clip-local seconds. */
export interface FocusKey {
  t: number;
  x: number;
  y: number;
}

/** Probe facts per asset id. */
export interface InputInfo {
  url: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface BuildOptions {
  inputs: Record<string, InputInfo>;
  /** Where the caller writes `ass` (when not null). */
  assPath: string;
  outPath: string;
  /** Where the caller writes `filter` (`-filter_complex_script`). */
  filterPath: string;
  /** Folder with the job's font files (libass `fontsdir`). */
  fontsDir?: string;
  /** Reframe paths by clip id (auto mode, from `reframe.ts`); missing → the clip's manual point or the center. */
  focus?: Record<string, FocusKey[]>;
  /** Intro / outro card text files and font files (the caller writes them). */
  cards?: { intro?: { textPath: string; fontFile: string }; outro?: { textPath: string; fontFile: string } };
  /** Audio-only output pattern (`%03d` chunk number). */
  audioPattern?: string;
}

export interface BuiltRender {
  args: string[];
  filter: string;
  ass: string | null;
  /** Number of `-i` inputs. */
  inputCount: number;
  /** Seconds of output (cut plus intro and outro cards). */
  totalDuration: number;
}

export const SAMPLE_RATE = 48000;
const EPS = 1e-6;

/** Number formatting for filter args: no exponent, at most 6 decimals. */
export function n(v: number): string {
  if (!Number.isFinite(v)) throw new Error("non-finite number in filter graph");
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
}

const clipLen = (c: MediaClip) => (c.out - c.in) / (c.speed ?? 1);
const clipEnd = (c: MediaClip) => c.start + clipLen(c);

/** `atempo` accepts 0.5..2 (older builds); chain factors for 0.25..4. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2 + EPS) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5 - EPS) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > EPS) out.push(`atempo=${n(s)}`);
  return out;
}

/** Piecewise-linear dB expression over `t` (seconds from the clip start), as in the editor's `gainAt`. */
export function keyframeDbExpr(kfs: GainKeyframe[]): string {
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (k.length === 1) return n(k[0]!.db);
  let expr = n(k[k.length - 1]!.db);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1]!;
    const b = k[i]!;
    const span = b.t - a.t || 1;
    expr = `if(lte(t,${n(b.t)}),${n(a.db)}+(${n(b.db - a.db)})*(t-(${n(a.t)}))/${n(span)},${expr})`;
  }
  return `if(lte(t,${n(k[0]!.t)}),${n(k[0]!.db)},${expr})`;
}

/** ASS time `h:mm:ss.cc`. */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Caption text as an ASS dialogue text: override braces and backslashes neutralised, newlines as `\N`. */
export function assText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\uFF3C")
    .replace(/\{/g, "\uFF5B")
    .replace(/\}/g, "\uFF5D")
    .split("\n")
    .map((l) => l.trim())
    .join("\\N");
}

/** `#RRGGBB` and opacity (0..1) to an ASS colour `&HAABBGGRR`. */
export function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? m[1]!.toUpperCase() : "FFFFFF";
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255).toString(16).toUpperCase().padStart(2, "0");
  return `&H${a}${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`;
}

/** The default look (captions before D-033): white DejaVu Sans with a thin outline. */
const DEFAULT_LOOK: CaptionLook = {
  id: "default", weight: 700, size: 0.055, outline: 0.08, box: null, shadow: false, marginV: 0.1, maxLines: 2,
  text: "#FFFFFF", outlineColor: "#000000", boxColor: "#000000", fontFamily: "DejaVu Sans", cjkFamily: "Noto Sans CJK SC",
};

const CJK_LANG = /^(zh|ja|ko|yue)\b/i;

/** The ASS `Style:` line for a look at the output size. CJK captions without a brand font use the regional Noto Sans CJK family. */
export function assStyle(look: CaptionLook, width: number, height: number, lang: string | null): string {
  const short = Math.min(width, height);
  const size = Math.max(8, Math.round(short * look.size));
  const margin = Math.round(short * 0.06);
  const marginV = Math.round(height * look.marginV);
  const font = (lang && CJK_LANG.test(lang) && (look.fontFamily === "Noto Sans" || look.fontFamily === "DejaVu Sans") ? look.cjkFamily : look.fontFamily).replace(/,/g, " ");
  const bold = look.weight >= 600 ? -1 : 0;
  let borderStyle = 1;
  let outline = look.outline > 0 ? Math.max(1, Math.round(size * look.outline)) : 0;
  let outlineColor = assColor(look.outlineColor);
  if (look.box) {
    // Opaque box: libass draws it in the outline colour, `Outline` is the padding.
    borderStyle = 3;
    outline = Math.max(2, Math.round(size * 0.28));
    outlineColor = assColor(look.boxColor, look.box.opacity);
  }
  const shadow = look.shadow ? Math.max(1, Math.round(size * 0.06)) : 0;
  return `Style: Caption,${font},${size},${assColor(look.text)},&H000000FF,${outlineColor},${assColor("#000000", 0.55)},${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${margin},${margin},${marginV},1`;
}

/** ASS subtitles for the caption tracks, sized to the output frame. Null without captions (or with burn-in off). */
export function buildAss(edl: Edl, width: number, height: number, duration: number, captions?: RenderCaptions | null): string | null {
  if (captions === null) return null;
  const lines: string[] = [];
  let lang: string | null = captions?.lang ?? null;
  for (const t of edl.tracks) {
    if (t.kind !== "caption") continue;
    lang ??= t.lang ?? null;
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const start = Math.max(0, c.start);
      const end = Math.min(duration, c.end);
      if (end - start <= EPS || !c.text.trim()) continue;
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${assText(c.text)}`);
    }
  }
  if (!lines.length) return null;
  const look = captions?.look ?? DEFAULT_LOOK;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    assStyle(look, width, height, lang),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}

/** Piecewise-linear expression of `v` over keys at times `t` (held before the first and after the last). */
export function pwlExpr(keys: readonly { t: number; v: number }[], variable = "t"): string {
  const k = [...keys].sort((a, b) => a.t - b.t);
  if (!k.length) return "0";
  if (k.length === 1) return n(k[0]!.v);
  let expr = n(k[k.length - 1]!.v);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1]!;
    const b = k[i]!;
    const span = b.t - a.t || 1;
    expr = `if(lte(${variable},${n(b.t)}),${n(a.v)}+(${n(b.v - a.v)})*(${variable}-(${n(a.t)}))/${n(span)},${expr})`;
  }
  return `if(lte(${variable},${n(k[0]!.t)}),${n(k[0]!.v)},${expr})`;
}

/**
 * `crop` for a reframed clip already scaled to cover W×H: the window follows
 * the focus path, clamped inside the picture.
 */
export function reframeCrop(W: number, H: number, focus: readonly FocusKey[]): string {
  const xs = focus.map((f) => ({ t: f.t, v: f.x }));
  const ys = focus.map((f) => ({ t: f.t, v: f.y }));
  const fx = pwlExpr(xs.length ? xs : [{ t: 0, v: 0.5 }]);
  const fy = pwlExpr(ys.length ? ys : [{ t: 0, v: 0.5 }]);
  return `crop=w=${W}:h=${H}:x='max(0,min(iw-ow,iw*(${fx})-ow/2))':y='max(0,min(ih-oh,ih*(${fy})-oh/2))'`;
}

/** Overlay position of the watermark at a corner, with a margin of 4% of the short side. */
export function watermarkXY(position: RenderBrand["watermark"] extends infer W ? (W extends { position: infer P } ? P : never) : never, W: number, H: number): { x: string; y: string } {
  const m = Math.round(Math.min(W, H) * 0.04);
  const left = position === "top_left" || position === "bottom_left";
  const top = position === "top_left" || position === "top_right";
  return { x: left ? String(m) : `main_w-overlay_w-${m}`, y: top ? String(m) : `main_h-overlay_h-${m}` };
}

/** ffmpeg colour from `#RRGGBB` (`0xRRGGBB`). */
function ffColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  return `0x${m ? m[1]!.toUpperCase() : "000000"}`;
}

function isIdentity(t: ClipTransform | undefined): boolean {
  return !t || (Math.abs(t.scale - 1) < EPS && Math.abs(t.x) < EPS && Math.abs(t.y) < EPS && Math.abs(t.rotation) < EPS && Math.abs(t.opacity - 1) < EPS);
}

/** Escapes a path for a filter option value (`ass=filename=...`). */
function filterPath(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:")}'`;
}

interface Segment {
  label: string;
  /** Seconds this segment lasts in the chain (handles included). */
  len: number;
  /** Transition into the next segment (xfade), seconds. */
  xfade: number;
}

/**
 * Builds the ffmpeg arguments, the filter graph and the ASS file for a job.
 * Clips whose asset has no input (or no picture / no sound) render as black /
 * silence. Times past `duration` are cut.
 */
export function buildRender(job: RenderJob, opts: BuildOptions): BuiltRender {
  const { width: W, height: H, fps, duration: D } = job;
  const filters: string[] = [];
  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"];
  let inputCount = 0;
  let labelSeq = 0;
  const label = (p: string) => `${p}${labelSeq++}`;

  /** One `-i` per clip use, seeking to its source range. */
  const addInput = (info: InputInfo, clip: MediaClip): number => {
    if (/^https?:/.test(info.url)) args.push("-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4");
    args.push("-ss", n(clip.in), "-t", n(clip.out - clip.in), "-i", info.url);
    return inputCount++;
  };
  const inputIndex = new Map<string, number>();
  const inputFor = (clip: MediaClip): { index: number; info: InputInfo } | null => {
    const info = clip.assetId ? opts.inputs[clip.assetId] : undefined;
    if (!info) return null;
    let index = inputIndex.get(clip.id);
    if (index === undefined) {
      index = addInput(info, clip);
      inputIndex.set(clip.id, index);
    }
    return { index, info };
  };

  const blank = (len: number, transparent: boolean): string => {
    const out = label("blank");
    filters.push(`color=c=black${transparent ? "@0" : ""}:s=${W}x${H}:r=${fps}:d=${n(len)},format=${transparent ? "yuva420p" : "yuv420p"},settb=AVTB[${out}]`);
    return out;
  };

  /** A video clip as a W×H segment of `len + head + tail` seconds. */
  const videoClip = (clip: MediaClip, head: number, tail: number, transparent: boolean): string => {
    const len = clipLen(clip);
    const src = inputFor(clip);
    if (!src || !src.info.hasVideo) return blank(len + head + tail, transparent);
    const speed = clip.speed ?? 1;
    const steps: string[] = [`[${src.index}:v]trim=duration=${n(clip.out - clip.in)}`, "setpts=PTS-STARTPTS"];
    if (clip.reverse) steps.push("reverse");
    if (Math.abs(speed - 1) > EPS) steps.push(`setpts=PTS/${n(speed)}`);
    steps.push(`fps=${fps}`);
    // A short source holds its last frame to fill the clip.
    steps.push(`tpad=stop_mode=clone:stop_duration=${n(len)}`, `trim=duration=${n(len)}`, "setpts=PTS-STARTPTS");
    const pix = transparent ? "yuva420p" : "yuv420p";
    let out: string;
    if (job.reframe && isIdentity(clip.transform) && !transparent) {
      // Aspect change: cover the frame and crop around the subject (no letterbox).
      const r = clip.reframe;
      const focus =
        r?.mode === "center" ? [{ t: 0, x: 0.5, y: 0.5 }]
        : r?.mode === "manual" ? [{ t: 0, x: r.x ?? 0.5, y: r.y ?? 0.5 }]
        : (opts.focus?.[clip.id] ?? [{ t: 0, x: 0.5, y: 0.5 }]);
      steps.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic`, "setsar=1", reframeCrop(W, H, focus));
      out = label("vc");
      filters.push(`${steps.join(",")}[${out}]`);
    } else if (isIdentity(clip.transform) && !transparent) {
      steps.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`, "setsar=1");
      steps.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
      out = label("vc");
      filters.push(`${steps.join(",")}[${out}]`);
    } else {
      steps.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`, "setsar=1");
      const t = clip.transform ?? { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 };
      if (Math.abs(t.scale - 1) > EPS) steps.push(`scale=trunc(iw*${n(t.scale)}/2)*2:trunc(ih*${n(t.scale)}/2)*2`);
      steps.push("format=rgba");
      if (t.opacity < 1 - EPS) steps.push(`colorchannelmixer=aa=${n(t.opacity)}`);
      if (Math.abs(t.rotation) > EPS) {
        const a = `${n(t.rotation)}*PI/180`;
        steps.push(`rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`);
      }
      const layer = label("layer");
      filters.push(`${steps.join(",")}[${layer}]`);
      const canvas = label("canvas");
      filters.push(`color=c=black${transparent ? "@0" : ""}:s=${W}x${H}:r=${fps}:d=${n(len)},format=rgba[${canvas}]`);
      out = label("vc");
      filters.push(`[${canvas}][${layer}]overlay=x=(main_w-overlay_w)/2+(${n(t.x)}):y=(main_h-overlay_h)/2+(${n(t.y)}):eof_action=pass:format=auto,trim=duration=${n(len)}[${out}]`);
    }
    const post: string[] = [];
    if (clip.fadeIn && clip.fadeIn > EPS) post.push(`fade=t=in:st=0:d=${n(Math.min(clip.fadeIn, len))}${transparent ? ":alpha=1" : ""}`);
    if (head > EPS) post.push(`tpad=start_mode=clone:start_duration=${n(head)}`);
    if (tail > EPS) post.push(`tpad=stop_mode=clone:stop_duration=${n(tail)}`);
    post.push(`format=${pix}`, "settb=AVTB", "setpts=PTS-STARTPTS");
    const seg = label("seg");
    filters.push(`[${out}]${post.join(",")}[${seg}]`);
    return seg;
  };

  /** One video track as a chain of segments covering 0..D. */
  const videoTrack = (clips: MediaClip[], transparent: boolean): string => {
    const sorted = clips.filter((c) => c.start < D - EPS && clipLen(c) > EPS).sort((a, b) => a.start - b.start);
    const segs: Segment[] = [];
    let cursor = 0;
    sorted.forEach((clip, i) => {
      if (clip.start > cursor + EPS) segs.push({ label: blank(clip.start - cursor, transparent), len: clip.start - cursor, xfade: 0 });
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      // A dissolve needs the next clip right at this clip's end.
      const into = (a: MediaClip | undefined, b: MediaClip | undefined) => (a?.transitionOut && b && Math.abs(b.start - clipEnd(a)) < 1e-3 ? Math.min(a.transitionOut.dur, clipLen(a), clipLen(b)) : 0);
      const head = into(prev, clip) / 2;
      const outT = into(clip, next);
      const tail = outT / 2;
      segs.push({ label: videoClip(clip, head, tail, transparent), len: clipLen(clip) + head + tail, xfade: outT });
      cursor = Math.max(cursor, clipEnd(clip));
    });
    if (cursor < D - EPS || !segs.length) segs.push({ label: blank(Math.max(D - cursor, 1 / fps), transparent), len: Math.max(D - cursor, 1 / fps), xfade: 0 });
    let cur = segs[0]!.label;
    let curLen = segs[0]!.len;
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]!;
      const seg = segs[i]!;
      const out = label("chain");
      if (prev.xfade > EPS) {
        filters.push(`[${cur}][${seg.label}]xfade=transition=fade:duration=${n(prev.xfade)}:offset=${n(curLen - prev.xfade)}[${out}]`);
        curLen += seg.len - prev.xfade;
      } else {
        filters.push(`[${cur}][${seg.label}]concat=n=2:v=1:a=0[${out}]`);
        curLen += seg.len;
      }
      cur = out;
    }
    const out = label("track");
    filters.push(`[${cur}]trim=duration=${n(D)},setpts=PTS-STARTPTS[${out}]`);
    return out;
  };

  // ---- video
  let outFps = fps;
  let ass: string | null = null;
  let introSec = 0;
  let outroSec = 0;
  let total = D;
  // Audio-only jobs (transcription) build no picture at all.
  if (!job.audioOnly) {
    const videoTracks = job.edl.tracks.filter((t): t is Extract<Track, { clips: MediaClip[] }> => t.kind === "video");
    let video = videoTracks.length ? videoTrack(videoTracks[0]!.clips, false) : blank(D, false);
    for (const t of videoTracks.slice(1)) {
      if (!t.clips.length) continue;
      const layer = videoTrack(t.clips, true);
      const out = label("comp");
      filters.push(`[${video}][${layer}]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[${out}]`);
      video = out;
    }
    outFps = job.interpolateFps ?? fps;
    if (job.interpolateFps && job.interpolateFps > fps) {
      // Motion-compensated in-between frames; scene cuts are detected and not blended.
      const out = label("smooth");
      filters.push(`[${video}]minterpolate=fps=${job.interpolateFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff[${out}]`);
      video = out;
    }
    const wm = job.brand?.watermark;
    if (wm) {
      if (/^https?:/.test(wm.url)) args.push("-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4");
      args.push("-loop", "1", "-t", n(D), "-i", wm.url);
      const idx = inputCount++;
      const logo = label("logo");
      const w = Math.max(16, Math.round((W * wm.size) / 2) * 2);
      filters.push(`[${idx}:v]scale=${w}:-2:flags=lanczos,format=rgba,colorchannelmixer=aa=${n(wm.opacity)},fps=${outFps}[${logo}]`);
      const { x, y } = watermarkXY(wm.position, W, H);
      const out = label("wm");
      filters.push(`[${video}][${logo}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto,format=yuv420p[${out}]`);
      video = out;
    }
    ass = buildAss(job.edl, W, H, D, job.captions);
    const fontsdir = opts.fontsDir ? `:fontsdir=${filterPath(opts.fontsDir)}` : "";
    const intro = job.brand?.intro && opts.cards?.intro ? job.brand.intro : null;
    const outro = job.brand?.outro && opts.cards?.outro ? job.brand.outro : null;
    const mainOut = intro || outro ? label("main") : "vout";
    filters.push(`[${video}]${ass ? `ass=filename=${filterPath(opts.assPath)}${fontsdir},` : ""}format=yuv420p,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[${mainOut}]`);
    const card = (c: RenderCard, files: { textPath: string; fontFile: string }): string => {
      const size = Math.round(Math.min(W, H) * 0.07);
      let out = label("card");
      filters.push(
        `color=c=${ffColor(c.background)}:s=${W}x${H}:r=${outFps}:d=${n(c.seconds)},format=yuv420p` +
          (c.text.trim() ? `,drawtext=fontfile=${filterPath(files.fontFile)}:textfile=${filterPath(files.textPath)}:fontcolor=${ffColor(c.color)}:fontsize=${size}:x=(w-text_w)/2:y=${c.logoUrl ? "h*0.62" : "(h-text_h)/2"}` : "") +
          `,setsar=1,settb=AVTB[${out}]`,
      );
      if (c.logoUrl) {
        if (/^https?:/.test(c.logoUrl)) args.push("-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4");
        args.push("-loop", "1", "-t", n(c.seconds), "-i", c.logoUrl);
        const idx = inputCount++;
        const logo = label("cardlogo");
        filters.push(`[${idx}:v]scale=${Math.round(W * 0.3)}:${Math.round(H * 0.3)}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,fps=${outFps}[${logo}]`);
        const withLogo = label("card");
        filters.push(`[${out}][${logo}]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2-main_h*0.06:eof_action=pass:format=auto,format=yuv420p,setsar=1,trim=duration=${n(c.seconds)},setpts=PTS-STARTPTS[${withLogo}]`);
        out = withLogo;
      }
      return out;
    };
    introSec = intro ? intro.seconds : 0;
    outroSec = outro ? outro.seconds : 0;
    total = D + introSec + outroSec;
    if (intro || outro) {
      const parts = [...(intro ? [card(intro, opts.cards!.intro!)] : []), mainOut, ...(outro ? [card(outro, opts.cards!.outro!)] : [])];
      filters.push(`${parts.map((p) => `[${p}]`).join("")}concat=n=${parts.length}:v=1:a=0,format=yuv420p[vout]`);
    }

  }

  // ---- audio
  const audioClip = (clip: MediaClip, kind: Track["kind"]): string | null => {
    const len = clipLen(clip);
    if (clip.start >= D - EPS || len <= EPS) return null;
    const src = inputFor(clip);
    if (!src || !src.info.hasAudio) return null;
    if (kind === "video" && !src.info.hasVideo) return null;
    const speed = clip.speed ?? 1;
    const steps: string[] = [`[${src.index}:a]atrim=duration=${n(clip.out - clip.in)}`, "asetpts=PTS-STARTPTS"];
    if (clip.reverse) steps.push("areverse");
    steps.push(...atempoChain(speed));
    steps.push(`aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`);
    // Voice lanes (imported voiceovers) are evened out before the mix.
    if (kind === "voice" && job.voiceLufs !== undefined) steps.push(`loudnorm=I=${n(job.voiceLufs)}:TP=-1.5:LRA=11`, `aresample=${SAMPLE_RATE}`);
    steps.push(`apad=whole_dur=${n(len)}`, `atrim=duration=${n(len)}`);
    if (clip.gainKeyframes?.length) steps.push(`volume='pow(10,(${keyframeDbExpr(clip.gainKeyframes)})/20)':eval=frame`);
    else if (clip.gainDb && Math.abs(clip.gainDb) > EPS) steps.push(`volume=${n(clip.gainDb)}dB`);
    if (clip.fadeIn && clip.fadeIn > EPS) steps.push(`afade=t=in:st=0:d=${n(Math.min(clip.fadeIn, len))}`);
    const ms = Math.round(clip.start * 1000);
    if (ms > 0) steps.push(`adelay=delays=${ms}:all=1`);
    const out = label("ac");
    filters.push(`${steps.join(",")}[${out}]`);
    return out;
  };

  interface Bus {
    trackId: string;
    label: string;
    duckUnder: string[];
  }
  const buses: Bus[] = [];
  for (const t of job.edl.tracks) {
    if (t.kind === "caption") continue;
    const labels = t.clips.map((c) => audioClip(c, t.kind)).filter((l): l is string => !!l);
    if (!labels.length) continue;
    let bus = labels[0]!;
    if (labels.length > 1) {
      bus = label("bus");
      filters.push(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[${bus}]`);
    }
    const duckUnder = [...new Set(t.clips.flatMap((c) => c.duckUnder ?? []))].filter((id) => id !== t.id);
    buses.push({ trackId: t.id, label: bus, duckUnder });
  }
  // Sidechain sources are split so they feed both the mix and the compressor.
  const uses = new Map<string, number>();
  for (const b of buses) for (const id of b.duckUnder) if (buses.some((x) => x.trackId === id)) uses.set(id, (uses.get(id) ?? 0) + 1);
  const taps = new Map<string, string[]>();
  for (const b of buses) {
    const extra = uses.get(b.trackId) ?? 0;
    if (!extra) continue;
    const outs = Array.from({ length: extra + 1 }, () => label("tap"));
    filters.push(`[${b.label}]asplit=${extra + 1}${outs.map((o) => `[${o}]`).join("")}`);
    b.label = outs[0]!;
    taps.set(b.trackId, outs.slice(1));
  }
  for (const b of buses) {
    const sources = b.duckUnder.filter((id) => taps.has(id)).map((id) => taps.get(id)!.shift()!);
    if (!sources.length) continue;
    let sc = sources[0]!;
    if (sources.length > 1) {
      sc = label("sc");
      filters.push(`${sources.map((s) => `[${s}]`).join("")}amix=inputs=${sources.length}:duration=longest:normalize=0[${sc}]`);
    }
    const out = label("ducked");
    filters.push(`[${b.label}][${sc}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350:makeup=1[${out}]`);
    b.label = out;
  }
  const enc = job.encode;
  const audioTail: string[] = [];
  if (introSec > EPS) audioTail.push(`adelay=delays=${Math.round(introSec * 1000)}:all=1`);
  audioTail.push(`apad=whole_dur=${n(total)}`, `atrim=duration=${n(total)}`, "asetpts=PTS-STARTPTS");
  if (enc?.loudnessLufs !== null && enc?.loudnessLufs !== undefined) {
    audioTail.push(`loudnorm=I=${n(enc.loudnessLufs)}:TP=${n(enc.truePeakDb)}:LRA=11`, `aresample=${SAMPLE_RATE}`, `atrim=duration=${n(total)}`);
  }
  const audioOut = job.audioOnly ? "amono" : "aout";
  if (job.audioOnly) audioTail.push(`aformat=sample_fmts=s16:sample_rates=${job.audioOnly.sampleRate}:channel_layouts=mono`);
  if (!buses.length) filters.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,${[`atrim=duration=${n(total)}`, ...audioTail.filter((f) => !/^(adelay|apad|atrim|asetpts)/.test(f))].join(",")}[${audioOut}]`);
  else {
    const mix = buses.length === 1 ? buses[0]!.label : label("mix");
    if (buses.length > 1) filters.push(`${buses.map((b) => `[${b.label}]`).join("")}amix=inputs=${buses.length}:duration=longest:normalize=0[${mix}]`);
    filters.push(`[${mix}]${audioTail.join(",")}[${audioOut}]`);
  }

  if (job.audioOnly) {
    // Transcription input: mono 16 kHz MP3 chunks; the picture is not built at all.
    const filter = filters.join(";\n");
    args.push(
      "-filter_complex_script", opts.filterPath, "-map", "[amono]", "-c:a", "libmp3lame", "-b:a", "48k", "-ar", String(job.audioOnly.sampleRate), "-ac", "1",
      "-t", n(D), "-f", "segment", "-segment_time", String(job.audioOnly.chunkSeconds), "-reset_timestamps", "1",
      opts.audioPattern ?? opts.outPath,
    );
    return { args, filter, ass: null, inputCount, totalDuration: D };
  }

  const filter = filters.join(";\n");
  const rate = enc?.videoKbps ? ["-b:v", `${enc.videoKbps}k`, "-maxrate", `${enc.maxKbps ?? enc.videoKbps}k`, "-bufsize", `${enc.bufferKbps ?? enc.videoKbps * 2}k`] : ["-crf", String(enc?.crf ?? 20)];
  args.push(
    "-filter_complex_script",
    opts.filterPath,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    ...rate,
    ...(enc ? ["-profile:v", enc.profile, "-level:v", enc.level] : []),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(outFps),
    "-c:a",
    "aac",
    "-b:a",
    `${enc?.audioKbps ?? 192}k`,
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-t",
    n(total),
    opts.outPath,
  );
  return { args, filter, ass, inputCount, totalDuration: total };
}
