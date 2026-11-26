/** Strong ETag of a response body: the first 12 bytes of its SHA-256, hex. */
export async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

/** A 304 with `headers` when the request's `If-None-Match` matches `etag`, else null. */
export function notModified(request: Request, etag: string, headers: Headers): Response | null {
  return request.headers.get("if-none-match") === etag ? new Response(null, { status: 304, headers }) : null;
}

/** The Workers default edge cache, absent outside Workers. */
export function edgeCache(): Cache | undefined {
  return typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
}
