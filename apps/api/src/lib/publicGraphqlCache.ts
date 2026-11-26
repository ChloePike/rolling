/**
 * Edge cache (Cache API, per colo) for GraphQL reads of the public library: operations whose root
 * fields are all in `PUBLIC_ROOT_FIELDS`. Their resolvers take no caller input (non-mature
 * `public_items` rows, public media URLs), so the response is the same for every caller and is
 * never per-user. Anything else — a mutation, another root field, a fragment at the root — runs
 * uncached. Only 200 responses without `errors` are stored.
 */
import { Kind, parse, type DocumentNode } from "graphql";
import { edgeCache, etagFor } from "./httpCache";

export const PUBLIC_ROOT_FIELDS: ReadonlySet<string> = new Set(["publicItems", "publicSubCategories", "publicCategories", "__typename"]);
/** The library only changes on import; a minute keeps a re-import visible quickly. */
export const PUBLIC_GRAPHQL_TTL_SECONDS = 60;
const VERSION = 1;
const MAX_BODY = 8 * 1024;

interface GraphqlRequest {
  query: string;
  variables?: unknown;
  operationName?: string | null;
}

/** True when every operation in the document is a query selecting only public root fields. */
export function isPublicOnly(doc: DocumentNode): boolean {
  let ops = 0;
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) return false;
    if (def.operation !== "query") return false;
    ops++;
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD || !PUBLIC_ROOT_FIELDS.has(sel.name.value)) return false;
    }
  }
  return ops > 0;
}

async function readRequest(req: Request): Promise<GraphqlRequest | null> {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const query = u.searchParams.get("query");
    if (!query) return null;
    let variables: unknown;
    try {
      variables = JSON.parse(u.searchParams.get("variables") ?? "null");
    } catch {
      return null;
    }
    return { query, variables, operationName: u.searchParams.get("operationName") };
  }
  if (req.method !== "POST" || !(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  const text = await req.clone().text();
  if (text.length > MAX_BODY) return null;
  try {
    const body = JSON.parse(text) as Partial<GraphqlRequest>;
    return typeof body.query === "string" ? { query: body.query, variables: body.variables, operationName: body.operationName ?? null } : null;
  } catch {
    return null;
  }
}

/** Runs `execute` for the request, through the edge cache when the operation is public-only. */
export async function withPublicGraphqlCache(
  req: Request,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  execute: () => Promise<Response>,
): Promise<Response> {
  const cache = edgeCache();
  if (!cache) return execute();
  const gql = await readRequest(req);
  if (!gql) return execute();
  try {
    if (!isPublicOnly(parse(gql.query))) return execute();
  } catch {
    return execute(); // Let Yoga report the syntax error.
  }
  const hash = (await etagFor(JSON.stringify([gql.query, gql.variables ?? null, gql.operationName ?? null]))).replaceAll('"', "");
  const key = new Request(`${new URL(req.url).origin}/__edge/graphql/v${VERSION}?h=${hash}`);
  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-edge-cache", "HIT");
    return res;
  }
  const res = await execute();
  if (res.status !== 200) return res;
  const body = await res.text();
  const out = new Response(body, res);
  out.headers.set("x-edge-cache", "MISS");
  let ok = false;
  try {
    ok = !(JSON.parse(body) as { errors?: unknown[] }).errors?.length;
  } catch {
    ok = false;
  }
  if (ok && ctx) {
    const stored = new Response(body, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": `public, max-age=${PUBLIC_GRAPHQL_TTL_SECONDS}`,
        etag: await etagFor(body),
      },
    });
    ctx.waitUntil(cache.put(key, stored).catch(() => undefined));
  }
  return out;
}
