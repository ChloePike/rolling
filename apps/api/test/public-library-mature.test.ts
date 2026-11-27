/**
 * D-005 mature public-library items: visible (list, search, counts; GraphQL and REST) only to
 * mature-allowed callers, always through signed private URLs, never from the public host, and
 * never mixed into the shared edge cache of public GraphQL reads.
 */
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { personalWorkspaceId } from "../src/auth/workspace";
import { yoga } from "../src/graphql/index";

const BASE = "https://example.com";
const DAY = 86_400_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

let seq = 0;
function api(userId: string | null, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-dev-user", userId);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`${BASE}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

type Caller = "signedOut" | "nonMember" | "memberPrefOff" | "memberWorkspaceOff" | "matureAllowed";

/** A dev identity of each caller type (null = signed out). */
async function caller(kind: Caller): Promise<string | null> {
  if (kind === "signedOut") return null;
  const user = `mpl${kind.toLowerCase()}${Date.now().toString(36)}${++seq}`;
  expect((await api(user, "/api/projects")).status).toBe(200);
  const ws = personalWorkspaceId(user);
  if (kind !== "nonMember") {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO subscriptions (id, workspace_id, plan, interval, status, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'plus', 'month', 'active', ?, 0, ?)")
      .bind(`sub_${user}`, ws, now + 30 * DAY, now)
      .run();
  }
  if (kind === "matureAllowed" || kind === "memberWorkspaceOff") await env.DB.prepare("UPDATE user_prefs SET mature_content = 1 WHERE user_id = ?").bind(user).run();
  if (kind === "memberWorkspaceOff") await env.DB.prepare("UPDATE workspaces SET mature_allowed = 0 WHERE id = ?").bind(ws).run();
  return user;
}

async function gql(user: string | null, query: string, variables: Record<string, unknown> = {}): Promise<{ res: Response; body: any }> {
  const res = await api(user, "/api/graphql", { method: "POST", json: { query, variables }, headers: { accept: "application/json" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.errors).toBeUndefined();
  return { res, body };
}

const ITEMS = /* GraphQL */ `
  query MplItems($category: String, $q: String) {
    publicItems(category: $category, q: $q, first: 100) {
      edges { node { id mature thumbUrl depthUrl angles { name url depthUrl } } }
    }
  }
`;
const COUNTS = /* GraphQL */ `
  query MplCounts { publicCategories { key count } publicSubCategories(category: "mpl_pose") { key count } }
`;

/** Library rows of a test-only category (`mpl_pose`), so counts here are exact. */
const ROWS = [
  { id: "pw_mpl_safe1", title: "Standing figure", sub: "single", mature: 0 },
  { id: "pw_mpl_safe2", title: "Walking figure", sub: "single", mature: 0 },
  { id: "pw_mpl_m1", title: "Couple embrace", sub: "couple", mature: 1 },
  { id: "pw_mpl_m2", title: "Couple figure lean", sub: "single", mature: 1 },
];
const MATURE_IDS = ROWS.filter((r) => r.mature).map((r) => r.id);
const SAFE_IDS = ROWS.filter((r) => !r.mature).map((r) => r.id);
const keyOf = (id: string, angle: string) => `public/mpl_pose/${id}/${angle}.png`;

beforeAll(async () => {
  const stmts: D1PreparedStatement[] = [];
  ROWS.forEach((r, i) => {
    const angles = ["front", "side"].map((a) => ({ name: a, label: { en: a }, assetId: `ast_${r.id}_${a}`, r2Key: keyOf(r.id, a), depthR2Key: keyOf(r.id, `${a}_depth`) }));
    for (const a of angles) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, license, created_at, status, mature) VALUES (?, NULL, 'image', 'public', ?, ?, '{}', 'first-party', ?, 'ready', ?)",
        ).bind(a.assetId, `${r.title} ${a.name}`, a.r2Key, Date.now() + i, r.mature),
      );
    }
    stmts.push(
      env.DB.prepare(
        "INSERT INTO public_items (id, category, sub, title, prompt_en, tags, asset_id, license, source, mature, sort, angles, depth_key) VALUES (?, 'mpl_pose', ?, ?, ?, '[]', ?, 'first-party', 'https://posewear.pages.dev/', ?, ?, ?, ?)",
      ).bind(r.id, r.sub, r.title, `${r.title} figure prompt`, angles[0]!.assetId, r.mature, i + 1, JSON.stringify(angles), angles[0]!.depthR2Key),
    );
  });
  await env.DB.batch(stmts);
  for (const r of ROWS) await env.MEDIA.put(keyOf(r.id, "front"), PNG, { httpMetadata: { contentType: "image/png" } });
});

const ids = (body: any): string[] => body.data.publicItems.edges.map((e: any) => e.node.id).sort();
const countOf = (facets: Array<{ key: string; count: number }>, key: string) => facets.find((f) => f.key === key)?.count ?? 0;

describe("mature public-library items (D-005)", () => {
  it("only mature-allowed callers see them in lists, search and counts; everyone else sees exactly the non-mature set", async () => {
    for (const kind of ["signedOut", "nonMember", "memberPrefOff", "memberWorkspaceOff", "matureAllowed"] as Caller[]) {
      const user = await caller(kind);
      const allowed = kind === "matureAllowed";
      const list = await gql(user, ITEMS, { category: "mpl_pose" });
      expect(ids(list.body), kind).toEqual((allowed ? [...SAFE_IDS, ...MATURE_IDS] : SAFE_IDS).sort());
      // Search ("figure" matches every row's title or prompt).
      const search = await gql(user, ITEMS, { q: "figure" });
      expect(ids(search.body).filter((id) => id.startsWith("pw_mpl_")), kind).toEqual((allowed ? [...SAFE_IDS, ...MATURE_IDS] : SAFE_IDS).sort());
      const counts = await gql(user, COUNTS);
      expect(countOf(counts.body.data.publicCategories, "mpl_pose"), kind).toBe(allowed ? 4 : 2);
      expect(counts.body.data.publicSubCategories, kind).toEqual(allowed ? [{ key: "couple", count: 1 }, { key: "single", count: 3 }] : [{ key: "single", count: 2 }]);
      for (const e of list.body.data.publicItems.edges) expect(e.node.mature).toBe(MATURE_IDS.includes(e.node.id));
      // REST catalog (`@` picker, agent): every angle asset of a mature item, only for allowed callers.
      if (user) {
        const rest = await api(user, "/api/assets?scope=public&first=100");
        expect(rest.status).toBe(200);
        const restIds = ((await rest.json()) as { items: Array<{ id: string; mature: boolean; url: string | null }> }).items.filter((a) => a.id.startsWith("ast_pw_mpl_"));
        const matureRest = restIds.filter((a) => a.mature);
        expect(matureRest.length, kind).toBe(allowed ? 4 : 0);
        for (const a of matureRest) expect(a.url).toMatch(/^\/media\/public\/mpl_pose\/.+[?&]sig=/);
      }
    }
  });

  it("their images are signed private URLs (hour-aligned), never the public host; the public route refuses them", async () => {
    const user = await caller("matureAllowed");
    const { body } = await gql(user, ITEMS, { category: "mpl_pose" });
    const nodes = body.data.publicItems.edges.map((e: any) => e.node);
    for (const n of nodes) {
      const urls = [n.thumbUrl, n.depthUrl, ...n.angles.flatMap((a: any) => [a.url, a.depthUrl])];
      for (const u of urls) {
        if (n.mature) {
          expect(u).toMatch(/^\/media\/public\/mpl_pose\/pw_mpl_m\d\/[a-z_]+\.png\?/);
          const exp = Number(new URL(u, BASE).searchParams.get("exp"));
          expect(exp % 3600).toBe(0);
          expect(new URL(u, BASE).searchParams.get("ws")).toBe("_");
        } else expect(u).toMatch(/^\/api\/media\/public\/mpl_pose\//);
      }
    }
    // The signed URL serves the object from the private bucket; the public route never does.
    const m1 = nodes.find((n: any) => n.id === "pw_mpl_m1");
    expect((await SELF.fetch(`${BASE}${m1.thumbUrl}`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/media/${keyOf("pw_mpl_m1", "front")}`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/media/${keyOf("pw_mpl_safe1", "front")}`)).status).toBe(200);
    // Tampered signatures are refused.
    expect((await SELF.fetch(`${BASE}${m1.thumbUrl.replace(/sig=[^&]+/, "sig=AAAA")}`)).status).toBe(403);
  });

  it("with the production media hosts, mature URLs are on the private host only and never on the public media host", async () => {
    const prodEnv = { ...env, PUBLIC_MEDIA_BASE_URL: "https://media.example.test", PRIVATE_MEDIA_BASE_URL: "https://cdn-private.example.test" } as Env;
    const run = async (matureAllowed: boolean) => {
      const res = await yoga.fetch(
        new Request(`${BASE}/api/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: ITEMS, variables: { category: "mpl_pose" } }) }),
        { env: prodEnv, user: { id: "u" }, auth: { matureAllowed } as never },
      );
      return ((await res.json()) as any).data.publicItems.edges.map((e: any) => e.node);
    };
    const allowed = await run(true);
    const general = await run(false);
    expect(general.map((n: any) => n.id).sort()).toEqual(SAFE_IDS.sort());
    for (const n of allowed) {
      const urls: string[] = [n.thumbUrl, n.depthUrl, ...n.angles.flatMap((a: any) => [a.url, a.depthUrl])];
      for (const u of urls) {
        if (n.mature) {
          expect(u.startsWith("https://cdn-private.example.test/media/public/")).toBe(true);
          expect(u).toContain("sig=");
        } else expect(u.startsWith("https://media.example.test/public/")).toBe(true);
      }
    }
    expect(JSON.stringify(allowed.filter((n: any) => n.mature))).not.toContain("media.example.test");
  });

  it("the public GraphQL edge cache never mixes the two audiences", async () => {
    const mature = await caller("matureAllowed");
    const off = await caller("memberPrefOff");
    const q = "query MplCache { publicItems(category: \"mpl_pose\", first: 50) { edges { node { id mature } } } publicCategories { key count } }";
    // The mature caller asks first: bypassed, private, and not stored.
    const m1 = await gql(mature, q);
    expect(m1.res.headers.get("x-edge-cache")).toBe("BYPASS");
    expect(m1.res.headers.get("cache-control")).toBe("private, no-store");
    expect(ids(m1.body)).toEqual([...SAFE_IDS, ...MATURE_IDS].sort());
    // Everyone else: MISS, then HIT, always without mature items or counts.
    const s1 = await gql(null, q);
    expect(s1.res.headers.get("x-edge-cache")).toBe("MISS");
    expect(ids(s1.body)).toEqual(SAFE_IDS.slice().sort());
    let hit: { res: Response; body: any } | null = null;
    for (let i = 0; i < 20; i++) {
      hit = await gql(off, q);
      if (hit.res.headers.get("x-edge-cache") === "HIT") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(hit!.res.headers.get("x-edge-cache")).toBe("HIT");
    expect(ids(hit!.body)).toEqual(SAFE_IDS.slice().sort());
    expect(countOf(hit!.body.data.publicCategories, "mpl_pose")).toBe(2);
    // With a cached general answer in place, the mature caller still gets its own, uncached one.
    const m2 = await gql(mature, q);
    expect(m2.res.headers.get("x-edge-cache")).toBe("BYPASS");
    expect(ids(m2.body)).toEqual([...SAFE_IDS, ...MATURE_IDS].sort());
    expect(countOf(m2.body.data.publicCategories, "mpl_pose")).toBe(4);
  });
});
