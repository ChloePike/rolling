/**
 * The private media hostname (D-008): `PRIVATE_MEDIA_BASE_URL`'s host (e.g.
 * `cdn-private.rolling.actor`) is a custom domain of this Worker that answers
 * only signed media URLs (`/media/<key>?exp=&ws=&sig=`, see routes/signedMedia.ts).
 * Everything else on that host is 404: no API, no SPA, no unsigned objects.
 *
 * Responses carry CORS for the app origins so the web app can `fetch()` media
 * (downloads with Range, canvas reads); `<img>`/`<video>` need no CORS.
 */
import { trustedOrigins } from "../auth/betterAuth";

export function privateMediaHostname(env: Env): string | null {
  const base = (env as { PRIVATE_MEDIA_BASE_URL?: string }).PRIVATE_MEDIA_BASE_URL;
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the request arrived on the private media hostname. */
export function isPrivateMediaHost(env: Env, url: URL): boolean {
  const host = privateMediaHostname(env);
  return !!host && url.host.toLowerCase() === host;
}

const CORS_ALLOW_HEADERS = "range, if-range, if-none-match";
const CORS_EXPOSE_HEADERS = "content-length, content-range, accept-ranges, etag";

/** Adds CORS headers when `origin` is one of the app origins. */
export function withMediaCors(env: Env, origin: string | null | undefined, res: Response): Response {
  if (!origin || !trustedOrigins(env).includes(origin)) return res;
  const out = new Response(res.body, res);
  out.headers.set("access-control-allow-origin", origin);
  out.headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  out.headers.append("vary", "origin");
  return out;
}

/** CORS preflight answer for the private media host. */
export function mediaPreflight(env: Env, origin: string | null | undefined): Response {
  if (!origin || !trustedOrigins(env).includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, HEAD",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-max-age": "86400",
      vary: "origin",
    },
  });
}
