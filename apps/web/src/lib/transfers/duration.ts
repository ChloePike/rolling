/** Length of an audio/video file as the browser reads it (metadata only). */

const TIMEOUT_MS = 1500;

export const isTimed = (contentType: string): boolean => contentType.startsWith('audio/') || contentType.startsWith('video/');

export const durationField = (ms: number | undefined): { durationMs?: number } => (ms !== undefined ? { durationMs: ms } : {});

/**
 * Resolves the file's length in whole milliseconds, or undefined when the
 * browser can't tell within a short wait (unsupported codec, no DOM).
 */
export function mediaDurationMs(file: Blob, timeoutMs = TIMEOUT_MS): Promise<number | undefined> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    let url = '';
    let settled = false;
    const done = (ms: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      if (url) URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : undefined);
    el.onerror = () => done(undefined);
    try {
      url = URL.createObjectURL(file);
      el.src = url;
    } catch {
      done(undefined);
    }
  });
}
