import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { personalWorkspaceId } from "../src/auth/workspace";

/** Home "Recent conversations" (docs/ux-audit.md #36): the caller's own threads on a surface, from any device. */

let seq = 0;
const newUser = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

async function gql(user: string | null, query: string, variables: Record<string, unknown> = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (user) headers.set("x-dev-user", user);
  const res = await SELF.fetch("https://example.com/api/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> };
}

const Q = /* GraphQL */ `
  query ($surface: String!, $first: Int) {
    agentThreads(surface: $surface, first: $first) { id projectId surface title updatedAt }
  }
`;

async function insert(id: string, ws: string, by: string, surface: string, title: string | null, updatedAt: number, projectId: string | null = null) {
  await env.DB.prepare("INSERT INTO agent_threads (id, workspace_id, project_id, surface, skill, title, updated_at, created_by) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
    .bind(id, ws, projectId, surface, title, updatedAt, by)
    .run();
}

describe("GraphQL agentThreads", () => {
  it("lists the caller's own titled threads on a surface, newest first; not other people's, other surfaces or empty threads", async () => {
    const me = newUser("thr");
    const other = newUser("thr");
    for (const u of [me, other]) {
      const r = await SELF.fetch("https://example.com/api/projects", { headers: { "x-dev-user": u } });
      expect(r.status).toBe(200);
    }
    const ws = personalWorkspaceId(me);
    const t = Date.now();
    await insert(`thr_a_${me}`, ws, me, "home", "A lamp ad, 15 seconds", t - 3000);
    await insert(`thr_b_${me}`, ws, me, "home", "Sneaker drop teaser", t - 1000);
    await insert(`thr_c_${me}`, ws, me, "home", null, t);
    await insert(`thr_d_${me}`, ws, me, "canvas", "Built on canvas", t, "prj_x");
    await insert(`thr_e_${me}`, ws, other, "home", "Someone else", t);
    await insert(`thr_f_${me}`, personalWorkspaceId(other), me, "home", "Another workspace", t);

    const r = await gql(me, Q, { surface: "home" });
    expect(r.errors).toBeUndefined();
    expect(r.data.agentThreads.map((x: { id: string }) => x.id)).toEqual([`thr_b_${me}`, `thr_a_${me}`]);
    expect(r.data.agentThreads[0]).toMatchObject({ surface: "home", title: "Sneaker drop teaser", projectId: null });
    expect((await gql(me, Q, { surface: "home", first: 1 })).data.agentThreads).toHaveLength(1);
    // projectless (D-039): a built Home thread (it has a project) never crowds out an older unbuilt one.
    await insert(`thr_g_${me}`, ws, me, "home", "Built from Home", t + 1000, "prj_y");
    const QP = `query ($surface: String!, $first: Int, $projectless: Boolean) { agentThreads(surface: $surface, first: $first, projectless: $projectless) { id } }`;
    expect((await gql(me, QP, { surface: "home", first: 1 })).data.agentThreads.map((x: { id: string }) => x.id)).toEqual([`thr_g_${me}`]);
    expect((await gql(me, QP, { surface: "home", first: 1, projectless: true })).data.agentThreads.map((x: { id: string }) => x.id)).toEqual([`thr_b_${me}`]);
    expect((await gql(me, Q, { surface: "elsewhere" })).errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect((await gql(null, Q, { surface: "home" })).errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });
});
