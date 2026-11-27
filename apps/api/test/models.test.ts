import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import listing from "../../../packages/core/src/models/__fixtures__/hyperouter-models.json";
import { MODEL_ABSENT_GRACE_MS, ModelSyncError, syncModels } from "../src/models/sync";
import { handleScheduled, MODEL_SYNC_CRON } from "../src/scheduled";

type Entry = Record<string, unknown> & { id: string; prices: { meter: string; usd: string; conditions: object }[] };
const entries = (listing as unknown as { data: Entry[] }).data;
const syncEnv = { ...env, HYPEROUTER_API_KEY: "sk-hr-test" } as Env;
const T0 = Date.UTC(2026, 10, 25, 0, 0, 0);

function mockListing(data: unknown, status = 200) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function count(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM models").first<{ n: number }>())!.n;
}

describe("syncModels", () => {
  beforeAll(async () => {
    await env.DB.exec("DELETE FROM models");
  });

  it("fetches the listing with the API key and inserts every model", async () => {
    const { fetch, calls } = mockListing(listing);
    const diff = await syncModels(syncEnv, { fetch, now: () => T0 });
    expect(calls).toEqual([{ url: "https://api.hyperouter.app/v1/models", auth: "Bearer sk-hr-test" }]);
    expect(diff.total).toBe(entries.length);
    expect(diff.added).toHaveLength(entries.length);
    expect(diff).toMatchObject({ changed: [], missing: [], deleted: [], skipped: [] });
    expect(diff.unmapped["x-ai/grok-imagine-video-1.5"]).toEqual(["param:keyframes", "param:voices"]);
    expect(await count()).toBe(entries.length);
    const row = await env.DB.prepare("SELECT * FROM models WHERE id = ?").bind("lumina/z-image-spicy").first<Record<string, unknown>>();
    expect(row).toMatchObject({ kind: "image", hidden: 0, mature: 1, synced_at: T0 });
    expect(JSON.parse(String(row!.price))).toEqual([{ meter: "image", conditions: {}, usd: 0.013, minUnits: 0, unitStep: 1 }]);
  });

  it("reports changes, keeps absent models for 24 h, then deletes them", async () => {
    const changed = structuredClone(entries).filter((e) => e.id !== "lumina/berry-1.0");
    const s25 = changed.find((e) => e.id === "bytedance/seedance-2.5")!;
    s25.prices = s25.prices.map((p) => (p.meter === "video_second" ? { ...p, usd: String(Number(p.usd) * 2) } : p));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const later = await syncModels(syncEnv, { fetch: mockListing({ data: changed }).fetch, now: () => T0 + 3_600_000 });
    expect(later).toMatchObject({ added: [], changed: ["bytedance/seedance-2.5"], missing: ["lumina/berry-1.0"], deleted: [] });
    expect(await count()).toBe(entries.length);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ msg: "models: synced", changed: ["bytedance/seedance-2.5"] });

    const dayLater = await syncModels(syncEnv, {
      fetch: mockListing({ data: changed }).fetch,
      now: () => T0 + MODEL_ABSENT_GRACE_MS + 1,
    });
    expect(dayLater).toMatchObject({ changed: [], missing: [], deleted: ["lumina/berry-1.0"] });
    expect(await count()).toBe(entries.length - 1);
    log.mockRestore();
  });

  it("changes nothing when the gateway fails or the listing is empty", async () => {
    const before = await count();
    await expect(syncModels(syncEnv, { fetch: mockListing({ error: {} }, 503).fetch, now: () => T0 + 10 * MODEL_ABSENT_GRACE_MS })).rejects.toBeInstanceOf(ModelSyncError);
    await expect(syncModels(syncEnv, { fetch: mockListing({ data: [] }).fetch, now: () => T0 + 10 * MODEL_ABSENT_GRACE_MS })).rejects.toThrow(/no models/);
    await expect(syncModels({ ...env } as Env, { fetch: mockListing(listing).fetch })).rejects.toThrow(/HYPEROUTER_API_KEY/);
    expect(await count()).toBe(before);
  });

  it("the cron handler logs a failed sync instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await handleScheduled({ cron: MODEL_SYNC_CRON, scheduledTime: T0, noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(String(error.mock.calls[0]![0])).toContain("models: sync failed");
    error.mockRestore();
  });
});

describe("model catalog reads", () => {
  beforeAll(async () => {
    await env.DB.exec("DELETE FROM models");
    await syncModels(syncEnv, { fetch: mockListing(listing).fetch, now: () => Date.now() });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (id, name, kind, mature_allowed, created_at) VALUES ('ws_adult', 'A', 'personal', 1, 0)"),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_adult', 'usr_adult', 'owner')"),
      env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_adult', 'usr_prefs_off', 'editor')"),
      env.DB.prepare(
        "INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, updated_at) VALUES ('sub_1', 'ws_adult', 'pro', 'month', 'active', 99999999999999, 0)",
      ),
      env.DB.prepare("INSERT INTO user_prefs (user_id, mature_content) VALUES ('usr_adult', 1)"),
      env.DB.prepare("INSERT INTO user_prefs (user_id, mature_content) VALUES ('usr_prefs_off', 0)"),
    ]);
  });

  async function getModels(query = "", user?: string) {
    const res = await SELF.fetch(`https://example.com/api/models${query}`, { headers: user ? { "x-dev-user": user } : {} });
    return { res, body: (await res.json()) as { models: any[] } };
  }

  it("returns an ETag and 304 when the client already has the catalog", async () => {
    const first = await SELF.fetch("https://example.com/api/models?kind=image");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/);
    await first.arrayBuffer();
    const again = await SELF.fetch("https://example.com/api/models?kind=image", { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
  });

  it("GET /api/models?kind=video lists video models with credits, cached 5 minutes", async () => {
    const { res, body } = await getModels("?kind=video");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(body.models.every((m) => m.kind === "video")).toBe(true);
    const s25 = body.models.find((m) => m.id === "bytedance/seedance-2.5");
    expect(s25).toMatchObject({ name: "Seedance 2.5", default: true, auto: true, mature: false, defaultResolution: "480p" });
    expect(s25.credits.filter((c: { seconds: number }) => c.seconds === 5)).toMatchObject([
      { resolution: "480p", seconds: 5, credits: 162 },
      { resolution: "720p", seconds: 5, credits: 347 },
      { resolution: "1080p", seconds: 5, credits: 853 },
    ]);
    // Every other whole length is priced on its own (a quote for 10 s rounds once, not 2 x the rounded 5 s).
    expect(s25.credits[0]).toMatchObject({ resolution: "480p", seconds: 5, credits: 162 });
    // D-020: with Enhance prompt the point adds the rewrite's most (never less than without).
    if (s25.promptExpand === "available") for (const c of s25.credits) expect(c.enhanced).toBeGreaterThanOrEqual(c.credits);
    const lengths = s25.credits.filter((c: { resolution: string }) => c.resolution === "720p").map((c: { seconds: number }) => c.seconds);
    expect(lengths.length).toBe(s25.seconds.max - s25.seconds.min + 1);
    const ten = s25.credits.find((c: { resolution: string; seconds: number }) => c.resolution === "720p" && c.seconds === 10);
    expect(ten.credits).toBeLessThanOrEqual(2 * 347);
    // No USD leaves the API.
    expect(JSON.stringify(body)).not.toContain("usd");
  });

  it("never lists mature-only models without a session", async () => {
    const { body } = await getModels();
    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("qwen/qwen-image-2.0");
    // Chat models are exposed as public agent LLM ids (D-009), never gateway ids.
    expect(ids).toContain("deepseek-v4.1-flash");
    expect(ids.some((id: string) => id.startsWith("deepseek/"))).toBe(false);
    expect(ids.some((id: string) => id.includes("-spicy"))).toBe(false);
  });

  it("lists mature-only models only for allowed callers (D-005)", async () => {
    const off = await getModels("?kind=image", "usr_prefs_off");
    expect(off.body.models.some((m) => m.matureOnly)).toBe(false);
    const nobody = await getModels("?kind=image", "usr_stranger");
    expect(nobody.body.models.some((m) => m.matureOnly)).toBe(false);
    const adult = await getModels("?kind=image", "usr_adult");
    expect(adult.res.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=600");
    expect(adult.body.models.map((m) => m.id)).toEqual(expect.arrayContaining(["lumina/z-image-spicy", "lumina/qwen-image-edit-spicy"]));
  });

  it("rejects an unknown kind", async () => {
    const { res, body } = await getModels("?kind=audio");
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("GraphQL models(kind) returns the same catalog", async () => {
    const res = await SELF.fetch("https://example.com/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ models(kind: IMAGE) { id kind name default matureOnly seconds { min } limits { inputImages } credits { resolution credits } } }",
      }),
    });
    const body = (await res.json()) as { data: { models: any[] }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    const lite = body.data.models.find((m) => m.id === "bytedance/seedream-5.0-lite");
    expect(lite).toEqual({
      id: "bytedance/seedream-5.0-lite",
      kind: "IMAGE",
      name: "Seedream 5.0 Lite",
      default: true,
      matureOnly: false,
      seconds: null,
      limits: { inputImages: 10 },
      credits: [{ resolution: null, credits: 11 }],
    });
    expect(body.data.models.every((m) => m.kind === "IMAGE" && !m.matureOnly)).toBe(true);
  });
});
