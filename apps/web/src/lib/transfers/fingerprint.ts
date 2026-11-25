/**
 * Upload fingerprint: SHA-256 over name, size, lastModified and the first and
 * last 1 MiB of the bytes. Cheap for multi-GB files, stable across reloads and
 * re-picks of the same file, so the server can hand back an unexpired upload
 * and the client can match a re-picked file to a stalled item.
 */
export const FINGERPRINT_SAMPLE = 1024 * 1024;

export async function fingerprint(file: Blob, name: string, lastModified: number): Promise<string> {
  const size = file.size;
  const head = file.slice(0, Math.min(size, FINGERPRINT_SAMPLE));
  const tail = size > FINGERPRINT_SAMPLE ? file.slice(Math.max(FINGERPRINT_SAMPLE, size - FINGERPRINT_SAMPLE), size) : new Blob([]);
  const meta = new TextEncoder().encode(`${name}\n${size}\n${lastModified}\n`);
  const bytes = new Blob([meta, head, tail]);
  const digest = await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer());
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
