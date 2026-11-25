/**
 * Serves an R2 object with resumable downloads (D-011): `Accept-Ranges: bytes`,
 * single `Range` requests (206 + Content-Range; 416 with `bytes *\/size` when
 * unsatisfiable), `If-Range` (ETag or date; a mismatch sends the full body),
 * ETag and conditional GET (`If-None-Match` → 304). Used by the signed private
 * media route and the public-library fallback route.
 */

export type ByteRange = { offset: number; length: number };

/** Parses one `bytes=` range against `size`. `null` = no/ignored range; `"invalid"` = 416. */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || header.includes(",")) return null; // multi-range and junk: serve the whole object
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (start >= size) return "invalid";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function ifRangeMatches(ifRange: string | null, etag: string, uploaded: Date): boolean {
  if (!ifRange) return true;
  const v = ifRange.trim();
  if (v.startsWith('"') || v.startsWith("W/")) return !v.startsWith("W/") && v === etag;
  const t = Date.parse(v);
  return Number.isFinite(t) && Math.floor(uploaded.getTime() / 1000) <= Math.floor(t / 1000);
}

export async function serveR2(
  bucket: R2Bucket,
  key: string,
  req: Request,
  opts: { cacheControl: string; contentType?: string; headers?: Record<string, string> },
): Promise<Response | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  if (opts.contentType) headers.set("content-type", opts.contentType);
  headers.set("etag", head.httpEtag);
  headers.set("last-modified", head.uploaded.toUTCString());
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", opts.cacheControl);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === head.httpEtag || t.trim() === "*")) return new Response(null, { status: 304, headers });

  const range = ifRangeMatches(req.headers.get("if-range"), head.httpEtag, head.uploaded) ? parseRange(req.headers.get("range"), head.size) : null;
  if (range === "invalid") {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  const isHead = req.method === "HEAD";
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("content-length", String(range.length));
    if (isHead) return new Response(null, { status: 206, headers });
    const obj = await bucket.get(key, { range });
    if (!obj) return null;
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(head.size));
  if (isHead) return new Response(null, { status: 200, headers });
  const obj = await bucket.get(key);
  if (!obj) return null;
  return new Response(obj.body, { status: 200, headers });
}
