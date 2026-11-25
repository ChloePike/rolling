import { ApiError } from "../lib/errors";

/** Client IP as Cloudflare sees it (falls back to a constant in local tests). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

/**
 * Applies a Workers rate-limit binding to `key`; throws RATE_LIMITED (429).
 * A missing binding (some local setups) does not limit.
 */
export async function limitOrThrow(binding: RateLimit | undefined, key: string, message = "Too many requests. Try again in a minute."): Promise<void> {
  if (!binding) return;
  const { success } = await binding.limit({ key });
  if (!success) throw new ApiError(429, "RATE_LIMITED", message, { retryAfter: 60 });
}

/** SHA-256 hex, used to keep raw emails and tokens out of rate-limit keys and tables. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
