/**
 * Public profiles (`GET /api/profiles/:handle`) and avatars
 * (`GET /api/media/avatar/:userId`). Both are public: no session needed.
 * D-005: only safe-rated media; D-008: the avatar route redirects to a signed
 * URL and never carries bytes.
 */
import { Hono } from "hono";
import { HANDLE_RE, normalizeHandle } from "@rolling/core/auth/profile";
import type { AppEnv } from "../env";
import { avatarUrl, publicProfile } from "../auth/profile";
import { clientIp, limitOrThrow } from "../auth/rateLimit";
import { errorResponse } from "../lib/errors";

export const profiles = new Hono<AppEnv>().get("/:handle", async (c) => {
  const handle = normalizeHandle(c.req.param("handle"));
  if (!HANDLE_RE.test(handle)) return errorResponse(c, 404, "NOT_FOUND", "Profile not found");
  await limitOrThrow(c.env.RATE_LIMIT, `profile-read:${clientIp(c.req.raw)}`);
  const profile = await publicProfile(c.env, handle);
  if (!profile) return errorResponse(c, 404, "NOT_FOUND", "Profile not found");
  const auth = c.get("auth");
  // Signed URLs inside: short private cache only.
  c.header("cache-control", "private, max-age=60");
  return c.json({ ...profile, isYou: auth?.userId === profile.userId });
});

export const avatars = new Hono<AppEnv>().get("/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  const url = await avatarUrl(c.env, userId);
  if (!url) return errorResponse(c, 404, "NOT_FOUND", "Not found");
  // The signed URL lives an hour; let browsers reuse the redirect for a few minutes.
  c.header("cache-control", "public, max-age=300");
  return c.redirect(url, 302);
});
