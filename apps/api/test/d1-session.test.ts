/**
 * D1 read replication through the Sessions API (apps/api/src/lib/d1Session.ts): where a session
 * starts, bookmark in/out, routing every `c.env.DB` query through the request's session, and
 * Server-Timing. A mocked session stands in for the remote replicas; the last block runs the real
 * middleware on the local D1.
 */
import { env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import {
  BOOKMARK_COOKIE,
  BOOKMARK_HEADER,
  d1SessionMiddleware,
  newerBookmark,
  routedEnv,
  sessionStart,
  validBookmark,
} from "../src/lib/d1Session";

const B1 = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";
const B2 = "00000085-0000024c-00004c6e-0000000000000000000000000000beef";
const B3 = "00000086-00000001-00000001-0000000000000000000000000000cafe";

/** A fake D1 binding: records where each session started and which session ran each query. */
function fakeDb(bookmarkAfter: string | null) {
  const starts: string[] = [];
  const ran: { session: number; sql: string; via: string }[] = [];
  let sessions = 0;
  const statement = (session: number, sql: string): D1PreparedStatement => {
    const s = {
      bind: () => statement(session, sql),
      first: async () => (ran.push({ session, sql, via: "first" }), { ok: 1 }),
      all: async () => (ran.push({ session, sql, via: "all" }), { results: [], success: true, meta: { served_by_region: "APAC", served_by_primary: false } }),
      run: async () => (ran.push({ session, sql, via: "run" }), { results: [], success: true, meta: {} }),
      raw: async () => (ran.push({ session, sql, via: "raw" }), []),
    };
    return s as unknown as D1PreparedStatement;
  };
  const db = {
    prepare: (sql: string) => statement(-1, sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession(start?: string) {
      const id = ++sessions;
      starts.push(start ?? "first-unconstrained");
      return {
        prepare: (sql: string) => statement(id, sql),
        batch: async (stmts: D1PreparedStatement[]) => {
          ran.push({ session: id, sql: `batch(${stmts.length})`, via: "batch" });
          return stmts.map(() => ({ results: [], success: true, meta: { served_by_region: "APAC", served_by_primary: false } }));
        },
        getBookmark: () => bookmarkAfter ?? (start && start.startsWith("0") ? start : null),
      };
    },
  };
  return { db: db as unknown as D1Database, starts, ran };
}

function appWith(db: D1Database) {
  const app = new Hono<AppEnv>();
  app.use("/api/*", d1SessionMiddleware);
  app.get("/api/read", async (c) => c.json(await c.env.DB.prepare("SELECT 1").first()));
  app.get("/api/batch", async (c) => {
    await c.env.DB.batch([c.env.DB.prepare("SELECT 1"), c.env.DB.prepare("SELECT 2").bind(1)]);
    await c.env.DB.prepare("SELECT 3").all();
    return c.json({ ok: true });
  });
  app.post("/api/write", async (c) => {
    await c.env.DB.prepare("UPDATE x SET y = 1").run();
    return c.json({ ok: true });
  });
  const bindings = { ...env, DB: db } as Env;
  return { fetch: (path: string, init?: RequestInit) => app.request(path, init, bindings), bindings };
}

describe("d1Session: where a session starts", () => {
  const req = (method: string, headers: Record<string, string> = {}, path = "/api/x") => new Request(`https://rolling.test${path}`, { method, headers });

  it("starts reads unconstrained and mutations on the primary", () => {
    expect(sessionStart(req("GET"))).toBe("first-unconstrained");
    expect(sessionStart(req("HEAD"))).toBe("first-unconstrained");
    expect(sessionStart(req("POST"))).toBe("first-primary");
    expect(sessionStart(req("PATCH"))).toBe("first-primary");
    expect(sessionStart(req("DELETE"))).toBe("first-primary");
    // GraphQL is read-only.
    expect(sessionStart(req("POST", {}, "/api/graphql"))).toBe("first-unconstrained");
  });

  it("starts from the client's bookmark (header or cookie, the newer one) for reads and writes", () => {
    expect(sessionStart(req("GET", { [BOOKMARK_HEADER]: B1 }))).toBe(B1);
    expect(sessionStart(req("POST", { [BOOKMARK_HEADER]: B1 }))).toBe(B1);
    expect(sessionStart(req("GET", { cookie: `a=b; ${BOOKMARK_COOKIE}=${B2}` }))).toBe(B2);
    expect(sessionStart(req("GET", { [BOOKMARK_HEADER]: B1, cookie: `${BOOKMARK_COOKIE}=${B2}` }))).toBe(B2);
    expect(newerBookmark(B3, B2)).toBe(B3);
  });

  it("ignores values that are not bookmarks", () => {
    for (const bad of ["first-primary", "", "x".repeat(300), "0000-zz", "'; DROP TABLE users; --"]) {
      expect(validBookmark(bad)).toBeNull();
      expect(sessionStart(req("GET", { [BOOKMARK_HEADER]: bad }))).toBe("first-unconstrained");
    }
  });
});

describe("d1Session: middleware with a mocked session", () => {
  it("runs handler queries in the request's session and returns its bookmark and timing", async () => {
    const fake = fakeDb(B2);
    const { fetch } = appWith(fake.db);
    const res = await fetch("/api/read", { headers: { [BOOKMARK_HEADER]: B1 } });
    expect(res.status).toBe(200);
    expect(fake.starts).toEqual([B1]);
    expect(fake.ran).toEqual([{ session: 1, sql: "SELECT 1", via: "first" }]);
    expect(res.headers.get(BOOKMARK_HEADER)).toBe(B2);
    expect(res.headers.get("server-timing")).toMatch(/^d1;dur=\d+;desc="n=1", total;dur=\d+$/);
    // Reads never set the cookie (public reads stay cacheable).
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends batches and bound statements through the same session and reports the serving region", async () => {
    const fake = fakeDb(B2);
    const { fetch } = appWith(fake.db);
    const res = await fetch("/api/batch");
    expect(fake.starts).toEqual(["first-unconstrained"]);
    expect(fake.ran.map((r) => r.session)).toEqual([1, 1]);
    expect(fake.ran.map((r) => r.via)).toEqual(["batch", "all"]);
    expect(res.headers.get("server-timing")).toContain('desc="n=2 APAC replica"');
  });

  it("starts mutations on the primary and leaves the new bookmark in a cookie too", async () => {
    const fake = fakeDb(B3);
    const { fetch } = appWith(fake.db);
    const res = await fetch("https://rolling.test/api/write", { method: "POST" });
    expect(fake.starts).toEqual(["first-primary"]);
    expect(res.headers.get(BOOKMARK_HEADER)).toBe(B3);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${BOOKMARK_COOKIE}=${B3}`);
    expect(cookie).toContain("Path=/api");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("opens one session per request", async () => {
    const fake = fakeDb(null);
    const { fetch } = appWith(fake.db);
    await fetch("/api/read");
    await fetch("/api/read");
    expect(fake.ran.map((r) => r.session)).toEqual([1, 2]);
  });

  it("keeps one routed env per binding set, so Better Auth's per-env cache still hits", () => {
    const fake = fakeDb(null);
    const bindings = { ...env, DB: fake.db } as Env;
    const a = routedEnv(bindings);
    expect(routedEnv(bindings)).toBe(a);
    expect(routedEnv(a)).toBe(a);
    expect(a.DB).not.toBe(fake.db);
  });

  it("queries outside a request (queues, crons, workflows, DOs) use the raw binding: the primary", async () => {
    const fake = fakeDb(null);
    const routed = routedEnv({ ...env, DB: fake.db } as Env);
    await routed.DB.prepare("SELECT 1").first();
    expect(fake.starts).toEqual([]);
    expect(fake.ran).toEqual([{ session: -1, sql: "SELECT 1", via: "first" }]);
  });
});

describe("d1Session: the real Worker on local D1", () => {
  it("adds Server-Timing to API responses and answers /api/health?timing=1", async () => {
    const res = await SELF.fetch("https://example.com/api/health?timing=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; d1: { ms: number; start: string }; r2: { ms: number }; edge: { ms: number } };
    expect(body.ok).toBe(true);
    expect(body.d1.start).toBe("first-unconstrained");
    expect(typeof body.r2.ms).toBe("number");
    expect(res.headers.get("server-timing")).toMatch(/d1;dur=\d+;desc="n=1[^"]*", total;dur=\d+/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a signed-in read and a write through sessions without changing responses", async () => {
    const user = `d1s${Date.now().toString(36)}`;
    const me = await SELF.fetch("https://example.com/api/me", { headers: { "x-dev-user": user } });
    expect(me.status).toBe(200);
    expect(me.headers.get("server-timing")).toMatch(/^d1;dur=\d+;desc="n=\d+/);
    const patched = await SELF.fetch("https://example.com/api/me/prefs", {
      method: "PATCH",
      headers: { "x-dev-user": user, "content-type": "application/json" },
      body: JSON.stringify({ theme: "light" }),
    });
    expect(patched.status).toBe(200);
    const again = await SELF.fetch("https://example.com/api/me", { headers: { "x-dev-user": user, [BOOKMARK_HEADER]: patched.headers.get(BOOKMARK_HEADER) ?? "" } });
    expect(((await again.json()) as { prefs: { theme: string } }).prefs.theme).toBe("light");
  });
});
