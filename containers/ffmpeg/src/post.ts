/**
 * Post-production commands (D-026..D-030), pure builders and parsers:
 * - last frame of a video (Extend clip: the next shot's first frame);
 * - pauses in a voice track (`silencedetect`, voiceover split);
 * - a cut of an audio track (lip-sync on one voice part);
 * - Resize: Lanczos scaling plus a mild unsharp (honestly not AI upscaling).
 * The server runs them (`/last-frame`, `/silences`, `/audio-cut`, `/jobs`).
 */

const net = (url: string) => (/^https?:/.test(url) ? ["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4"] : []);

/**
 * The last decoded frame as PNG into `out`: seek near the end (`-sseof`),
 * decode to the end and keep overwriting one file (`-update 1`), so the file
 * holds the true last frame even when the container's duration is off.
 */
export function lastFrameArgs(url: string, out: string, width: number | null, fromEnd = 1.5): string[] {
  return [
    "-v", "error", "-y",
    ...net(url),
    "-sseof", (-Math.abs(fromEnd)).toFixed(3),
    "-i", url,
    "-an", "-sn",
    ...(width ? ["-vf", `scale=${width}:-2:flags=lanczos`] : []),
    "-update", "1",
    "-c:v", "png",
    "-f", "image2",
    out,
  ];
}

export interface SilenceOptions {
  start?: number;
  duration?: number;
  noiseDb?: number;
  minSilence?: number;
}

/** ffmpeg arguments that log `silence_start` / `silence_end` lines (times relative to `start`). */
export function silenceArgs(url: string, o: SilenceOptions = {}): string[] {
  const noise = Math.min(-10, Math.max(-80, o.noiseDb ?? -35));
  const d = Math.min(5, Math.max(0.1, o.minSilence ?? 0.45));
  return [
    "-v", "info", "-hide_banner", "-nostats",
    ...net(url),
    ...(o.start ? ["-ss", o.start.toFixed(3)] : []),
    ...(o.duration ? ["-t", o.duration.toFixed(3)] : []),
    "-i", url,
    "-vn", "-sn",
    "-af", `silencedetect=noise=${noise}dB:d=${d}`,
    "-f", "null", "-",
  ];
}

export interface Silence {
  start: number;
  end: number;
}

/** Pairs `silence_start` / `silence_end` from the log; a trailing open silence ends at `until` when given. */
export function parseSilences(log: string, until?: number): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
    const v = Math.max(0, Number(m[2]));
    if (!Number.isFinite(v)) continue;
    if (m[1] === "start") open = v;
    else if (open !== null) {
      if (v > open) out.push({ start: Math.round(open * 1000) / 1000, end: Math.round(v * 1000) / 1000 });
      open = null;
    }
  }
  if (open !== null && until !== undefined && until > open) out.push({ start: Math.round(open * 1000) / 1000, end: until });
  return out;
}

/** A cut of an audio (or video) file's sound as AAC in M4A. */
export function audioCutArgs(url: string, start: number, duration: number, out: string): string[] {
  return ["-v", "error", "-y", ...net(url), "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", url, "-vn", "-sn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-f", "mp4", out];
}

/** Scale filter: the short side to `short` pixels with Lanczos, then a mild unsharp (luma only). */
export function resizeFilter(short: number): string {
  return `scale='if(lte(iw,ih),${short},-2)':'if(lte(iw,ih),-2,${short})':flags=lanczos,unsharp=5:5:0.5:5:5:0.0,setsar=1`;
}

/** Resize a video (H.264, audio copied) or an image (PNG). */
export function resizeArgs(media: "video" | "image", url: string, short: number, out: string): string[] {
  if (media === "image") return ["-v", "error", "-y", ...net(url), "-i", url, "-frames:v", "1", "-vf", resizeFilter(short), "-c:v", "png", "-f", "image2", out];
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats",
    ...net(url),
    "-i", url,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", resizeFilter(short),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-f", "mp4",
    out,
  ];
}
