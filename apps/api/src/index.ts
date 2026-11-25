import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env";
import { yoga } from "./graphql";
import { ApiError, errorResponse } from "./lib/errors";
import { isWebSocketUpgrade, refuseWebSocket } from "./lib/wsRefusal";
import { authMiddleware } from "./auth/context";
import { serveSpaFromR2 } from "./lib/r2Static";
import { handleQueue } from "./queues";
import { handleScheduled } from "./scheduled";
import { authRoutes } from "./routes/auth";
import { billing } from "./routes/billing";
import { stripeWebhook } from "./routes/stripe";
import { health } from "./routes/health";
import { me } from "./routes/me";
import { media } from "./routes/media";
import { models } from "./routes/models";
import { runs } from "./routes/runs";
import { agent } from "./routes/agent";
import { hooks } from "./routes/hooks";
import { realtime } from "./routes/realtime";
import { workspace } from "./routes/workspace";
import { testInbox } from "./routes/testInbox";
import { projects, nodes, canvases } from "./routes/projects";
import { assets, characters, voices } from "./routes/assets";
import { uploads } from "./routes/uploads";
import { privateMedia, share, signedMedia } from "./routes/signedMedia";

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
  // One auth context per request (M1): c.get("auth"), requireUser / requireMember / requireRole.
  .use("*", authMiddleware)
  .route("/health", health)
  .route("/auth", authRoutes)
  .route("/me", me)
  .route("/workspace", workspace)
  .route("/billing", billing)
  .route("/stripe", stripeWebhook)
  .route("/test", testInbox)
  .route("/projects", projects)
  .route("/nodes", nodes)
  .route("/canvases", canvases)
  .route("/share", share)
  .route("/assets/uploads", uploads)
  .route("/assets", assets)
  .route("/characters", characters)
  .route("/voices", voices)
  .route("/media/private", privateMedia)
  .route("/media", media)
  .route("/models", models)
  .route("/runs", runs)
  .route("/agent", agent)
  .route("/hooks", hooks)
  .route("/", realtime)
  .on(["GET", "POST"], "/graphql", async (c) =>
    yoga.fetch(c.req.raw, { env: c.env, user: c.get("user"), auth: c.get("auth") }),
  );

app.route("/api", api);
// Signed private media (D-008); moves to the media hostname once it exists.
app.route("/", signedMedia);

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
  // Refused WebSocket upgrades (bad session, membership, missing project): accept, send `error`, close 4401/4403/4404.
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 426 && isWebSocketUpgrade(c.req.raw)) {
    return refuseWebSocket(err.status, err.code, err.message, err.data);
  }
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
