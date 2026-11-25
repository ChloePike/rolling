import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env";
import { yoga } from "./graphql";
import { ApiError, errorResponse } from "./lib/errors";
import { getSessionUser } from "./lib/session";
import { serveSpaFromR2 } from "./lib/r2Static";
import { handleQueue } from "./queues";
import { handleScheduled } from "./scheduled";
import { health } from "./routes/health";
import { me } from "./routes/me";
import { media } from "./routes/media";
import { models } from "./routes/models";
import { realtime } from "./routes/realtime";

export { ProjectRoom } from "./do/ProjectRoom";
export { UserHub } from "./do/UserHub";
export { CreditAccount } from "./do/CreditAccount";
export { AgentSession } from "./do/AgentSession";
export { FfmpegRenderer } from "./containers/FfmpegRenderer";
export { GenerateWorkflow } from "./workflows/Generate";
export { ExportWorkflow } from "./workflows/Export";
export { BillingWorkflow } from "./workflows/Billing";

export const app = new Hono<AppEnv>();

const api = new Hono<AppEnv>()
  .route("/health", health)
  .route("/me", me)
  .route("/media", media)
  .route("/models", models)
  .route("/", realtime)
  .on(["GET", "POST"], "/graphql", async (c) =>
    yoga.fetch(c.req.raw, { env: c.env, user: await getSessionUser(c) }),
  );

app.route("/api", api);

app.notFound((c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return errorResponse(c, 404, "NOT_FOUND", "Route not found", { path: c.req.path });
  }
  // Assets normally answer non-API paths before the Worker runs; this covers
  // requests routed here anyway (e.g. tests, `run_worker_first` changes).
  const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;
  if (assets) return assets.fetch(c.req.raw);
  return serveSpaFromR2(c.env.MEDIA, c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(c, err.status, err.code, err.message, err.data);
  if (err instanceof HTTPException) {
    return errorResponse(c, err.status, err.status === 401 ? "UNAUTHENTICATED" : "BAD_REQUEST", err.message);
  }
  console.error(JSON.stringify({ msg: "unhandled error", path: c.req.path, error: String(err) }));
  return errorResponse(c, 500, "INTERNAL", "Something went wrong");
});

export type ApiRoutes = typeof api;

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
