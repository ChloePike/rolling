import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://example.com/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { data?: any; errors?: unknown[] };
}

const PUBLIC_ITEMS = /* GraphQL */ `
  query ($category: String, $q: String, $first: Int, $after: String) {
    publicItems(category: $category, q: $q, first: $first, after: $after) {
      edges { cursor node { id title license tags } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

describe("GraphQL publicItems", () => {
  beforeAll(async () => {
    const insert = env.DB.prepare(
      "INSERT INTO public_items (id, category, title, prompt_en, tags, asset_id, license, source, mature, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await env.DB.batch([
      insert.bind("pub_1", "pose", "Standing pose", "standing", '["stand"]', "ast_1", "first-party", "posewear", 0, 1),
      insert.bind("pub_2", "pose", "Sitting pose", "sitting", "[]", "ast_2", "first-party", "posewear", 0, 2),
      insert.bind("pub_3", "pose", "Hidden mature", "x", "[]", "ast_3", "first-party", "posewear", 1, 3),
      insert.bind("pub_4", "scene", "Beach scene", "beach", "[]", "ast_4", "cc0", "posewear", 0, 1),
    ]);
  });

  it("filters by category, paginates and never returns mature items", async () => {
    const page1 = await gql(PUBLIC_ITEMS, { category: "pose", first: 1 });
    expect(page1.errors).toBeUndefined();
    expect(page1.data.publicItems.edges.map((e: any) => e.node.id)).toEqual(["pub_1"]);
    expect(page1.data.publicItems.edges[0].node).toMatchObject({ license: "FIRST_PARTY", tags: ["stand"] });
    expect(page1.data.publicItems.pageInfo.hasNextPage).toBe(true);

    const page2 = await gql(PUBLIC_ITEMS, { category: "pose", first: 10, after: page1.data.publicItems.pageInfo.endCursor });
    expect(page2.data.publicItems.edges.map((e: any) => e.node.id)).toEqual(["pub_2"]);
    expect(page2.data.publicItems.pageInfo.hasNextPage).toBe(false);
  });

  it("searches by text", async () => {
    const res = await gql(PUBLIC_ITEMS, { q: "beach" });
    expect(res.data.publicItems.edges.map((e: any) => e.node.id)).toEqual(["pub_4"]);
  });

  it("rejects mutations (read-only schema)", async () => {
    const res = await gql("mutation { anything }");
    expect(res.errors).toBeDefined();
  });
});
