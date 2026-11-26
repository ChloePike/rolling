/**
 * Serves the SPA from R2 when the Workers static-assets binding is absent.
 *
 * Used for staging and production deploys made from environments that cannot upload Workers
 * assets (the asset upload JWT is rewritten by an auth-injecting proxy). The
 * build is uploaded to `<prefix>/` in the MEDIA bucket by `scripts/deploy/upload-web.mts`.
 * (`scripts/deploy/staging-r2.sh`, `production-r2.sh`). A CI deploy can use the `assets` binding instead.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

export const WEB_PREFIX = "_web";

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export async function serveSpaFromR2(bucket: R2Bucket, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) path += "index.html";
  if (path.includes("..")) return new Response("Bad request", { status: 400 });

  let object = await bucket.get(`${WEB_PREFIX}/${path}`);
  let servedPath = path;
  // SPA fallback: unknown paths without a file extension get index.html.
  if (!object && !/\.[a-z0-9]+$/i.test(path)) {
    object = await bucket.get(`${WEB_PREFIX}/index.html`);
    servedPath = "index.html";
  }
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "content-type": contentType(servedPath),
    etag: object.httpEtag,
    "cache-control": servedPath.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
