/**
 * SMPTE-style timecode `HH:MM:SS:FF` (non-drop frame). Frames are floored so
 * the display never runs ahead of the picture.
 */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.floor(Math.max(0, seconds) * fps + 1e-3);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(frames)}`;
}

/** Short clip length for lists, `m:ss` (e.g. `0:04`, `0:30`). */
export function formatClipLength(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Rounds a time to the nearest frame boundary. */
export function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}
