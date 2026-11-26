/**
 * Serves the SPA from R2 when the Workers static-assets binding is absent.
 *
 * Used for staging and production deploys made from environments that cannot upload Workers
 * assets (the asset upload JWT is rewritten by an auth-injecting proxy). The
 * build is uploaded to `<prefix>/` in the MEDIA bucket by `scripts/deploy/upload-web.mts`.
 * (`scripts/deploy/staging-r2.sh`, `production-r2.sh`). A CI deploy can use the `assets` binding instead.
 *
 * Edge cache: every file is served through the colo's Cache API (`caches.default`) so a visit
 * does not cross to the bucket's region (R2 sits in North America; from Asia that was ~0.5 s per
 * file). Edge lifetimes (`edgeTtl`): hashed `assets/*` a year (immutable names), `sw.js` 10 s,
 * everything else (`index.html`, legal pages, manifest, robots, icons) 60 s. Browsers still get
 * `cacheControl()`: `no-cache` + ETag for unhashed files, so they revalidate and a 304 comes from
 * the edge copy.
 *
 * Deploy safety (upload order: assets → index.html → sw.js): hashed files never change under a
 * name and old ones stay in the bucket, so an index.html up to 60 s old still loads. A request
 * with `Cache-Control: no-cache` / `Pragma: no-cache` skips the edge copy (and refreshes it):
 * Workbox precaches with `cache: 'reload'`, which sends exactly that, so a new service worker
 * always precaches the index.html uploaded before it, never a stale edge copy.
 *
 * HTML responses carry `Link` preloads for their entry script, stylesheet and preloaded font,
 * which Cloudflare turns into 103 Early Hints (zone setting on).
 */
import { edgeCache } from "./httpCache";

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
  xml: "application/xml; charset=utf-8",
};

export const WEB_PREFIX = "_web";

/** The PWA service worker script; the browser checks it for updates on every navigation. */
export const SERVICE_WORKER = "sw.js";

/** Bump to drop every edge copy at once (e.g. after changing the stored headers). */
const EDGE_VERSION = 1;

/**
 * Browser caching. Hashed build output (`assets/*`) never changes under a
 * name: cache for a year. Everything else — `index.html`, `sw.js`,
 * `manifest.webmanifest`, icons — revalidates every time (ETag, 304), so a
 * deploy reaches clients at once and the service worker sees its new version.
 */
export function cacheControl(path: string): string {
  return path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/** Edge (Cache API) lifetime in seconds for a served file. */
export function edgeTtl(path: string): number {
  if (path.startsWith("assets/")) return 31_536_000;
  if (path === SERVICE_WORKER) return 10;
  return 60;
}

export function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * `Link` preloads for an HTML document: the module entry, stylesheets and preloaded fonts it
 * references under `/assets/`. Cloudflare caches these for 103 Early Hints.
 */
export function preloadLinks(html: string): string | null {
  const end = html.indexOf("</head>");
  const head = end >= 0 ? html.slice(0, end) : html;
  const links: string[] = [];
  for (const m of head.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/g)) {
    links.push(`<${m[1]}>; rel=modulepreload; crossorigin`);
  }
  for (const m of head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(\/assets\/[^"]+\.css)"/g)) {
    links.push(`<${m[1]}>; rel=preload; as=style; crossorigin`);
  }
  for (const m of head.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bhref="(\/assets\/[^"]+\.woff2)"/g)) {
    links.push(`<${m[1]}>; rel=preload; as=font; type="font/woff2"; crossorigin`);
  }
  return links.length ? [...new Set(links)].join(", ") : null;
}

/** The request asks to skip caches (hard reload, Workbox precache with `cache: 'reload'`). */
function wantsFresh(request: Request): boolean {
  const cc = request.headers.get("cache-control") ?? "";
  return /\bno-cache\b|\bno-store\b/i.test(cc) || /\bno-cache\b/i.test(request.headers.get("pragma") ?? "");
}

function edgeKey(url: URL): Request {
  return new Request(`${url.origin}/__edge/web/v${EDGE_VERSION}${url.pathname}${url.search}`);
}

const SERVED_PATH = "x-served-path";

async function fromR2(bucket: R2Bucket, path: string): Promise<{ object: R2ObjectBody; servedPath: string } | null> {
  const object = await bucket.get(`${WEB_PREFIX}/${path}`);
  if (object) return { object, servedPath: path };
  if (/\.[a-z0-9]+$/i.test(path)) return null;
  // Build-time static pages (`/privacy` → `privacy.html`, apps/web/scripts/prerender-legal.mjs), as Workers assets do.
  const page = await bucket.get(`${WEB_PREFIX}/${path}.html`);
  if (page) return { object: page, servedPath: `${path}.html` };
  // SPA fallback: unknown paths without a file extension get index.html.
  const shell = await bucket.get(`${WEB_PREFIX}/index.html`);
  return shell ? { object: shell, servedPath: "index.html" } : null;
}

/** The copy kept at the edge: body plus the headers every response is built from. */
async function edgeCopy(object: R2ObjectBody, servedPath: string): Promise<Response> {
  const headers = new Headers({
    "content-type": contentType(servedPath),
    etag: object.httpEtag,
    "cache-control": `public, max-age=${edgeTtl(servedPath)}`,
    [SERVED_PATH]: servedPath,
  });
  if (servedPath.endsWith(".html")) {
    const html = await object.text();
    const link = preloadLinks(html);
    if (link) headers.set("link", link);
    return new Response(html, { headers });
  }
  return new Response(object.body, { headers });
}

/** The browser response from an edge copy: browser Cache-Control, 304 on a matching ETag, HEAD without body. */
function toClient(request: Request, copy: Response, edge: "HIT" | "MISS" | "BYPASS", timing: string[]): Response {
  const servedPath = copy.headers.get(SERVED_PATH) ?? "index.html";
  const headers = new Headers(copy.headers);
  headers.delete(SERVED_PATH);
  headers.delete("cf-cache-status");
  headers.set("cache-control", cacheControl(servedPath));
  // The PWA service worker (apps/web/src/sw.ts) controls the whole origin.
  if (servedPath === SERVICE_WORKER) headers.set("service-worker-allowed", "/");
  headers.set("x-edge-cache", edge);
  headers.set("server-timing", [`edge;desc="${edge}"`, ...timing].join(", "));
  if (request.headers.get("if-none-match") === copy.headers.get("etag")) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : copy.body, { headers });
}

export async function serveSpaFromR2(bucket: R2Bucket, request: Request, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const t0 = Date.now();
  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) path += "index.html";
  if (path.includes("..")) return new Response("Bad request", { status: 400 });

  const cache = edgeCache();
  const key = edgeKey(url);
  const fresh = wantsFresh(request);
  if (cache && !fresh) {
    const hit = await cache.match(key);
    if (hit) return toClient(request, hit, "HIT", [`total;dur=${Date.now() - t0}`]);
  }

  const r2Start = Date.now();
  const found = await fromR2(bucket, path);
  const r2Ms = Date.now() - r2Start;
  if (!found) return new Response("Not found", { status: 404, headers: { "server-timing": `r2;dur=${r2Ms}` } });

  const copy = await edgeCopy(found.object, found.servedPath);
  if (cache && ctx) ctx.waitUntil(cache.put(key, copy.clone()).catch(() => undefined));
  return toClient(request, copy, cache && fresh ? "BYPASS" : "MISS", [`r2;dur=${r2Ms}`, `total;dur=${Date.now() - t0}`]);
}
