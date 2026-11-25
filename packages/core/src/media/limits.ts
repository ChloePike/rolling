/** Upload limits and accepted types for user uploads (M3). */

export type UploadKind = 'image' | 'video' | 'audio';

const MB = 1024 * 1024;

export const UPLOAD_LIMITS: Record<UploadKind, { maxBytes: number; types: readonly string[] }> = {
  image: { maxBytes: 30 * MB, types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic'] },
  video: { maxBytes: 2048 * MB, types: ['video/mp4', 'video/quicktime', 'video/webm'] },
  audio: { maxBytes: 200 * MB, types: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/x-m4a'] },
};

/** Multipart part size (D-011: fixed 8 MiB, last part smaller); R2 needs ≥ 5 MiB for every part but the last. */
export const UPLOAD_PART_SIZE = 8 * MB;

export function uploadKindOf(contentType: string): UploadKind | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  for (const kind of Object.keys(UPLOAD_LIMITS) as UploadKind[]) {
    if (UPLOAD_LIMITS[kind].types.includes(type)) return kind;
  }
  return null;
}

export type UploadCheck =
  | { ok: true; kind: UploadKind; parts: number }
  | { ok: false; reason: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPTY'; maxBytes?: number };

export function checkUpload(contentType: string, size: number): UploadCheck {
  const kind = uploadKindOf(contentType);
  if (!kind) return { ok: false, reason: 'UNSUPPORTED_TYPE' };
  if (size <= 0) return { ok: false, reason: 'EMPTY' };
  const { maxBytes } = UPLOAD_LIMITS[kind];
  if (size > maxBytes) return { ok: false, reason: 'TOO_LARGE', maxBytes };
  return { ok: true, kind, parts: Math.max(1, Math.ceil(size / UPLOAD_PART_SIZE)) };
}

/** Safe last path segment for an R2 key. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-100);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

/** R2 multipart uploads expire after 7 days. */
export const UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000;

/** Expected size of part `n` (1-based) of an upload of `size` bytes. */
export function partSizeOf(size: number, n: number, partSize = UPLOAD_PART_SIZE): number {
  const parts = Math.max(1, Math.ceil(size / partSize));
  if (n < 1 || n > parts) return 0;
  return n < parts ? partSize : size - partSize * (parts - 1);
}
