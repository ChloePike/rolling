/**
 * Templates (docs/api.md → Templates): the seeded built-ins, GraphQL reads,
 * making a project from a template with filled slots (no spend), and "save
 * selection as template" (workspace-private).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, inferSlots } from "@rolling/core/templates";
import { personalWorkspaceId } from "../src/auth/workspace";
import { projectRoom } from "../src/lib/access";

const BASE = "https://example.com";
let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function signedIn(tag: string): Promise<{ user: string; ws: string }> {
  const user = newUser(tag);
  expect((await api(user, "/api/projects")).status).toBe(200);
  return { user, ws: personalWorkspaceId(user) };
}

async function imageAsset(ws: string, user: string): Promise<string> {
  const id = `ast_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
  await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, ?, 'image', 'mine', 'photo', ?, '{}', ?, ?, 'ready', 0)")
    .bind(id, ws, `ws/${ws}/uploads/${id}.png`, user, Date.now())
    .run();
  return id;
}

async function gql(user: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await api(user, "/api/graphql", { method: "POST", json: { query, variables } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data;
}

describe("templates: built-ins", () => {
  it("lists the seeded built-in templates with listing fields and slots; the seed matches the source", async () => {
    const { user } = await signedIn("tpl");
    const res = await api(user, "/api/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const builtins = body.items.filter((t: any) => t.source === "builtin");
    expect(builtins.map((t: any) => t.id).sort()).toEqual(BUILTIN_TEMPLATES.map((t) => t.id).sort());
    const tv = body.items.find((t: any) => t.id === "tpl_tv_ad_15s");
    expect(tv).toMatchObject({ name: "TV ad, 15 seconds", category: "product", durationSec: 15, ratio: "16:9", coverAspect: "16/9", roles: 1, hasLines: true, featured: true, nodeCount: 8 });
    expect(tv.slots).toEqual(inferSlots(BUILTIN_TEMPLATES.find((t) => t.id === "tpl_tv_ad_15s")!.graph));
    expect(body.featured.map((t: any) => t.id)).toContain("tpl_tv_ad_15s");
    // The seeded graph is the source graph (migration 0016 is generated from it).
    for (const t of BUILTIN_TEMPLATES) {
      const row = await env.DB.prepare("SELECT graph, title FROM templates WHERE id = ?").bind(t.id).first<{ graph: string; title: string }>();
      expect(row?.title).toBe(t.title);
      expect(JSON.parse(row!.graph)).toEqual(t.graph);
    }

    const filtered = (await (await api(user, "/api/templates?category=talking")).json()) as any;
    expect(filtered.items.map((t: any) => t.id)).toEqual(["tpl_talking_head"]);
    const searched = (await (await api(user, "/api/templates?q=comic")).json()) as any;
    expect(searched.items.map((t: any) => t.id)).toContain("tpl_comic_page");

    const one = (await (await api(user, "/api/templates/tpl_storyboard")).json()) as any;
    expect(one.template).toMatchObject({ id: "tpl_storyboard", source: "builtin" });
    expect(one.template.graph.nodes).toHaveLength(7);
    expect((await api(user, "/api/templates/tpl_nope")).status).toBe(404);
    expect((await api(null, "/api/templates")).status).toBe(401);
  });

  it("GraphQL templates(category, q) and template(id)", async () => {
    const { user } = await signedIn("tplgql");
    const data = await gql(user, `query($c: String, $q: String) { templates(category: $c, q: $q) { id name category source slots { id kind param required } } }`, { c: "product" });
    expect(data.templates.map((t: any) => t.id).sort()).toEqual(["tpl_product_showcase", "tpl_tv_ad_15s"]);
    expect(data.templates[0].slots.length).toBeGreaterThan(0);
    const one = await gql(user, `query($id: ID!) { template(id: $id) { id graph nodeCount } }`, { id: "tpl_talking_head" });
    expect(JSON.parse(one.template.graph).nodes).toHaveLength(3);
  });
});

describe("templates: instantiate and save", () => {
  it("POST /api/projects { fromTemplateId, slots } makes the graph with the fills, spends nothing, counts the use", async () => {
    const { user, ws } = await signedIn("tplnew");
    const photo = await imageAsset(ws, user);
    const before = (await env.DB.prepare("SELECT uses FROM templates WHERE id = 'tpl_tv_ad_15s'").first<{ uses: number }>())!.uses;
    const res = await api(user, "/api/projects", { method: "POST", json: { fromTemplateId: "tpl_tv_ad_15s", slots: { product: { assetId: photo }, script: { text: "Our new soda." } } } });
    expect(res.status, await res.clone().text()).toBe(201);
    const { project } = (await res.json()) as any;
    expect(project.title).toBe("TV ad, 15 seconds");
    const graph = (await projectRoom(env, project.id).getGraph({ userId: user, workspaceId: ws, canEdit: true })) as any;
    expect(graph.state.nodes).toHaveLength(8);
    expect(graph.state.edges).toHaveLength(6);
    const product = graph.state.nodes.find((n: any) => n.title === "Product photo");
    expect(product.params).toMatchObject({ assetId: photo, media: "image", source: "upload" });
    expect(graph.state.nodes.find((n: any) => n.title === "Script").params.text).toBe("Our new soda.");
    expect((await env.DB.prepare("SELECT uses FROM templates WHERE id = 'tpl_tv_ad_15s'").first<{ uses: number }>())!.uses).toBe(before + 1);
    // No run, no quote: nothing was spent.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes WHERE project_id = ?").bind(project.id).first<{ n: number }>()).toEqual({ n: 0 });

    // Bad fills are refused with the slot.
    const bad = await api(user, "/api/projects", { method: "POST", json: { fromTemplateId: "tpl_tv_ad_15s", slots: { product: { text: "x" } } } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error.data.slot).toBe("product");
    const foreign = await api(user, "/api/projects", { method: "POST", json: { fromTemplateId: "tpl_tv_ad_15s", slots: { product: { assetId: "ast_someone_else" } } } });
    expect(foreign.status).toBe(422);
    const wrongMedia = await api(user, "/api/projects", { method: "POST", json: { fromTemplateId: "tpl_talking_head", slots: { voice: { assetId: photo } } } });
    expect(wrongMedia.status).toBe(422);
  });

  it("saves a canvas selection as a workspace-private template with inferred slots", async () => {
    const { user, ws } = await signedIn("tplsave");
    const photo = await imageAsset(ws, user);
    const created = (await (await api(user, "/api/projects", { method: "POST", json: { title: "Mine" } })).json()) as any;
    const room = projectRoom(env, created.project.id);
    const caller = { userId: user, workspaceId: ws, canEdit: true };
    const r = (await room.applyPatch(caller, {
      baseRevision: 0,
      ops: [
        { op: "addNode", tempId: "a", kind: "asset", title: "Hero", params: { media: "image", assetId: photo }, position: { x: 400, y: 200 } },
        { op: "addNode", tempId: "b", kind: "image", title: "Still", params: { model: "bytedance/seedream-5.0-lite", prompt: "p" }, position: { x: 760, y: 200 } },
        { op: "addNode", tempId: "c", kind: "text", title: "Note", params: { text: "left out" }, position: { x: 0, y: 0 } },
        { op: "connect", from: { node: "a", port: "out" }, to: { node: "b", port: "refs" } },
      ],
    })) as any;
    expect(r.ok).toBe(true);
    const nodeIds = [r.idMap.a, r.idMap.b];
    const res = await api(user, "/api/templates", { method: "POST", json: { projectId: created.project.id, nodeIds, title: "My look", category: "outfit" } });
    expect(res.status, await res.clone().text()).toBe(201);
    const { template } = (await res.json()) as any;
    expect(template).toMatchObject({ name: "My look", source: "workspace", category: "outfit", nodeCount: 2, roles: 1 });
    expect(template.slots).toEqual([{ id: r.idMap.a, kind: "image", label: "Hero", param: "assetId", required: false, default: photo }]);
    expect(template.graph.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(template.graph.edges).toHaveLength(1);

    // Listed for this workspace only.
    const mine = (await (await api(user, "/api/templates")).json()) as any;
    expect(mine.items.some((t: any) => t.id === template.id)).toBe(true);
    const other = await signedIn("tplother");
    const theirs = (await (await api(other.user, "/api/templates")).json()) as any;
    expect(theirs.items.some((t: any) => t.id === template.id)).toBe(false);
    expect((await api(other.user, `/api/templates/${template.id}`)).status).toBe(404);

    // It instantiates like a built-in.
    const again = await api(user, "/api/projects", { method: "POST", json: { fromTemplateId: template.id } });
    expect(again.status).toBe(201);
    // Built-ins can't be deleted; own templates can.
    expect((await api(user, "/api/templates/tpl_storyboard", { method: "DELETE" })).status).toBe(404);
    expect((await api(user, `/api/templates/${template.id}`, { method: "DELETE" })).status).toBe(200);
    const missing = await api(user, "/api/templates", { method: "POST", json: { projectId: created.project.id, nodeIds: ["node_nope"], title: "x" } });
    expect(missing.status).toBe(404);
  });
});

describe("GraphQL Asset.rating (D-005)", () => {
  it("returns the content rating so clients blur suggestive and explicit thumbnails", async () => {
    const { user, ws } = await signedIn("rating");
    const ids: Record<string, string> = {};
    for (const rating of ["safe", "suggestive", null] as const) {
      const id = await imageAsset(ws, user);
      await env.DB.prepare("UPDATE assets SET rating = ?, mature = ? WHERE id = ?").bind(rating, rating === "suggestive" ? 1 : 0, id).run();
      ids[String(rating)] = id;
    }
    await env.DB.prepare("INSERT INTO user_prefs (user_id, mature_content) VALUES (?, 1) ON CONFLICT (user_id) DO UPDATE SET mature_content = 1").bind(user).run();
    const data = await gql(user, "{ assets(scope: MINE) { edges { node { id mature rating } } } }");
    const byId = new Map(data.assets.edges.map((e: any) => [e.node.id, e.node]));
    expect(byId.get(ids.safe)).toMatchObject({ rating: "safe", mature: false });
    expect(byId.get(ids.null)).toMatchObject({ rating: null });
    // Non-members never see mature assets (D-005), so a suggestive one is not listed here.
    expect(byId.has(ids.suggestive)).toBe(false);
    const rest = (await (await api(user, `/api/assets/${ids.safe}`)).json()) as any;
    expect(rest.asset.rating).toBe("safe");
  });
});
