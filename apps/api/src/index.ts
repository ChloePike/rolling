import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env";
import { yoga } from "./graphql";
import { ApiError, errorResponse } from "./lib/errors";
import { isWebSocketUpgrade, refuseWebSocket } from "./lib/wsRefusal";
import { authMiddleware } from "./auth/context";
import { serveSpaFromR2 } from "./lib/r2Static";
import { d1SessionMiddleware } from "./lib/d1Session";
import { withPublicGraphqlCache } from "./lib/publicGraphqlCache";
import { robotsPolicy } from "./lib/robots";
import { isPrivateMediaHost, mediaPreflight, withMediaCors } from "./lib/privateMediaHost";
import { handleQueue } from "./queues";
import { handleScheduled } from "./scheduled";
import { authRoutes } from "./routes/auth";
import { billing } from "./routes/billing";
import { stripeWebhook } from "./routes/stripe";
import { health } from "./routes/health";
import { me } from "./routes/me";
import { account } from "./routes/account";
import { media } from "./routes/media";
import { models } from "./routes/models";
import { runs } from "./routes/runs";
import { templates } from "./routes/templates";
import { showcase } from "./routes/showcase";
import { agent } from "./routes/agent";
import { hooks } from "./routes/hooks";
import { realtime } from "./routes/realtime";
import { workspace } from "./routes/workspace";
import { testInbox } from "./routes/testInbox";
import { testPlan } from "./routes/testPlan";
import { adminGrant } from "./routes/adminGrant";
import { projects, nodes, canvases } from "./routes/projects";
import { canvasExports, exportsRoute } from "./routes/exports";
import { assetPost, brandKit, canvasPost, postJobs } from "./routes/post";
import { assets, characters, voices } from "./routes/assets";
import { uploads } from "./routes/uploads";
import { privateMedia, share, signedMedia } from "./routes/signedMedia";
import { avatars, profiles } from "./routes/profiles";
import { feedback } from "./routes/feedback";

export { ProjectRoom } from "./do/ProjectRoom";
export { UserHub } from "./do/UserHub";
export { CreditAccount } from "./do/CreditAccount";
export { AgentSession } from "./do/AgentSession";
export { FfmpegRenderer } from "./containers/FfmpegRenderer";
export { GenerateWorkflow } from "./workflows/Generate";
export { ExportWorkflow } from "./workflows/Export";
export { BillingWorkflow } from "./workflows/Billing";
export { AccountDeletionWorkflow } from "./workflows/AccountDeletion";
export { DataExportWorkflow } from "./workflows/DataExport";
export { PostWorkflow } from "./workflows/Post";

export const app = new Hono<AppEnv>();

/** The request's ExecutionContext, or undefined (`app.request()` in tests has none). */
function executionCtxOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): Pick<ExecutionContext, "waitUntil"> | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

// Only production is indexed: elsewhere robots.txt disallows all, no sitemap, X-Robots-Tag on every response (LEGAL-3).
app.use("*", robotsPolicy);

// `www.<app host>` (custom domain on this Worker) redirects to the apex app URL (D-015).
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.startsWith("www.") && c.env.PUBLIC_APP_URL) {
    const app = new URL(c.env.PUBLIC_APP_URL);
    if (url.hostname === `www.${app.hostname}`) {
      return c.redirect(`${app.origin}${url.pathname}${url.search}`, 301);
    }
  }
  await next();
});

// The private media hostname (D-008) answers only signed media URLs; nothing else is reachable there.
app.use("*", async (c, next) => {
  if (!isPrivateMediaHost(c.env, new URL(c.req.url))) return next();
  const origin = c.req.header("origin");
  if (c.req.method === "OPTIONS") return mediaPreflight(c.env, origin);
  if ((c.req.method === "GET" || c.req.method === "HEAD") && c.req.path.startsWith("/media/")) {
    return withMediaCors(c.env, origin, await signedMedia.fetch(c.req.raw, c.env, c.executionCtx));
  }
  return errorResponse(c, 404, "NOT_FOUND", "Not found");
});

// D1 read replication (Sessions API): one session per API request, bookmark in/out, Server-Timing (lib/d1Session.ts).
app.use("/api/*", d1SessionMiddleware);

const api = new Hono<AppEnv>()
  // One auth context per request (M1): c.get("auth"), requireUser / requireMember / requireRole.
  .use("*", authMiddleware)
  .route("/health", health)
  .route("/auth", authRoutes)
  .route("/me", me)
  .route("/account", account)
  .route("/workspace", workspace)
  .route("/billing", billing)
  .route("/stripe", stripeWebhook)
  .route("/test", testInbox)
  .route("/test", testPlan)
  .route("/admin", adminGrant)
  .route("/projects", projects)
  .route("/nodes", nodes)
  .route("/canvases", canvases)
  .route("/canvases", canvasExports)
  .route("/exports", exportsRoute)
  .route("/canvases", canvasPost)
  .route("/post-jobs", postJobs)
  .route("/brand-kit", brandKit)
  .route("/assets", assetPost)
  .route("/share", share)
  .route("/assets/uploads", uploads)
  .route("/assets", assets)
  .route("/characters", characters)
  .route("/voices", voices)
  .route("/media/private", privateMedia)
  .route("/media/avatar", avatars)
  .route("/profiles", profiles)
  .route("/feedback", feedback)
  .route("/media", media)
  .route("/models", models)
  .route("/runs", runs)
  .route("/templates", templates)
  .route("/showcase", showcase)
  .route("/agent", agent)
  .route("/hooks", hooks)
  .route("/", realtime)
  .on(["GET", "POST"], "/graphql", async (c) =>
    // Public-library-only operations are the same for every caller who is not mature-allowed: edge-cached
    // (lib/publicGraphqlCache.ts). Mature-allowed callers (D-005) bypass the cache entirely.
    withPublicGraphqlCache(c.req.raw, executionCtxOf(c), async () => yoga.fetch(c.req.raw, { env: c.env, user: c.get("user"), auth: c.get("auth") }), {
      matureAllowed: c.get("auth")?.matureAllowed === true,
    }),
  );

app.route("/api", api);
// Signed private media (D-008) on the app host: local dev and URLs issued before PRIVATE_MEDIA_BASE_URL was set.
app.route("/", signedMedia);

app.notFound((c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return errorResponse(c, 404, "NOT_FOUND", "Route not found", { path: c.req.path });
  }
  // Assets normally answer non-API paths before the Worker runs; this covers
  // requests routed here anyway (e.g. tests, `run_worker_first` changes).
  const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;
  if (assets) return assets.fetch(c.req.raw);
  return serveSpaFromR2(c.env.MEDIA, c.req.raw, executionCtxOf(c));
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
