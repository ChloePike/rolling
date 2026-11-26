/** Edge cache for public-library GraphQL reads (apps/api/src/lib/publicGraphqlCache.ts). */
import { SELF } from "cloudflare:test";
import { parse } from "graphql";
import { describe, expect, it } from "vitest";
import { isPublicOnly } from "../src/lib/publicGraphqlCache";

const gql = (query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  SELF.fetch("https://example.com/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });

describe("publicGraphqlCache", () => {
  it("only treats queries with public-library root fields as cacheable", () => {
    expect(isPublicOnly(parse("query { publicCategories { key count } }"))).toBe(true);
    expect(isPublicOnly(parse("query Q($c: String!) { publicSubCategories(category: $c) { key } publicItems(first: 2) { edges { cursor } } }"))).toBe(true);
    expect(isPublicOnly(parse("{ publicCategories { key } projects { edges { cursor } } }"))).toBe(false);
    expect(isPublicOnly(parse("{ ...F } fragment F on Query { publicCategories { key } }"))).toBe(false);
    expect(isPublicOnly(parse("{ models { id } }"))).toBe(false);
    expect(isPublicOnly(parse("mutation { x }"))).toBe(false);
  });

  it("answers the second identical public query from the edge cache, for signed-in callers too", async () => {
    const q = "query Facets { publicCategories { key count } }";
    const first = await gql(q);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-edge-cache")).toBe("MISS");
    const firstBody = await first.text();
    // waitUntil(cache.put) settles after the response; poll briefly.
    let second: Response | null = null;
    for (let i = 0; i < 20; i++) {
      second = await gql(q, {}, { "x-dev-user": `gqlc${i}` });
      if (second.headers.get("x-edge-cache") === "HIT") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(second!.headers.get("x-edge-cache")).toBe("HIT");
    expect(await second!.text()).toBe(firstBody);
  });

  it("never caches per-user or failing operations", async () => {
    const user = await gql("{ projects(first: 1) { edges { cursor } } }", {}, { "x-dev-user": "gqlcuser" });
    expect(user.headers.get("x-edge-cache")).toBeNull();
    const bad = await gql("query { publicItems(first: 500) { edges { cursor } } }");
    expect(bad.headers.get("x-edge-cache")).toBe("MISS");
    const again = await gql("query { publicItems(first: 500) { edges { cursor } } }");
    expect(again.headers.get("x-edge-cache")).toBe("MISS");
  });
});
