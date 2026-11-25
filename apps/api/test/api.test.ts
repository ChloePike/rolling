import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("REST", () => {
  it("GET /api/health returns 200", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "rolling-api" });
  });

  it("unknown /api route returns the error envelope with 404", async () => {
    const res = await SELF.fetch("https://example.com/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found", data: { path: "/api/does-not-exist" } },
    });
  });

  it("GET /api/me without a session returns 401", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});

describe("GraphQL", () => {
  it("answers { health }", async () => {
    const res = await SELF.fetch("https://example.com/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ health { ok environment } }" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { health: { ok: true, environment: "development" } } });
  });
});
