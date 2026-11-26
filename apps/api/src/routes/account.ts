/**
 * Account data rights: `POST /api/account/export` starts a data export
 * (DataExportWorkflow, one per 24 h, link emailed), `GET /api/account/export`
 * reads the latest one. Deletion lives under `/api/me/delete*` (routes/me.ts).
 */
import { Hono } from "hono";
import { DATA_EXPORT_LINK_TTL_DAYS } from "@rolling/core/privacy";
import { dataExportView, latestDataExport, requestDataExport } from "../account/dataExport";
import { requireUser } from "../auth/context";
import { limitOrThrow } from "../auth/rateLimit";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";

export const account = new Hono<AppEnv>()
  /** `{}` → 202 `{ export: DataExportView, email, linkTtlDays }`; 429 `RATE_LIMITED { retryAfter, nextAvailableAt }`. */
  .post("/export", async (c) => {
    const auth = requireUser(c);
    if (!auth.user?.email) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    await limitOrThrow(c.env.RATE_LIMIT, `data-export:${auth.userId}`);
    const row = await requestDataExport(c.env, auth.userId);
    return c.json({ export: dataExportView(row), email: auth.user.email, linkTtlDays: DATA_EXPORT_LINK_TTL_DAYS }, 202);
  })
  /** → `{ export: DataExportView | null }`. */
  .get("/export", async (c) => {
    const auth = requireUser(c);
    c.header("cache-control", "private, no-store");
    const row = await latestDataExport(c.env, auth.userId);
    return c.json({ export: row ? dataExportView(row) : null });
  });
