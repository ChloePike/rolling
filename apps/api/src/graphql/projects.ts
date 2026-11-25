/**
 * GraphQL reads for M3: recent projects and the asset catalog (`@` picker).
 * Same auth context and visibility rules as REST (`listProjects`, `listAssets`).
 */
import { GraphQLError } from "graphql";
import { listProjects } from "../routes/projects";
import { ASSET_SCOPES, listAssets, type AssetScope } from "../routes/assets";
import type { GraphQLContext } from "./index";

export const projectsTypeDefs = /* GraphQL */ `
  extend type Query {
    "Projects of the current workspace, recently updated first."
    projects(first: Int = 24, after: String): ProjectConnection!
    "Asset catalog for the @ picker and Assets pages. Mature assets only for allowed viewers (D-005)."
    assets(scope: AssetScope = ALL, kind: AssetKind, q: String, first: Int = 48, after: String): AssetConnection!
  }

  type Project {
    id: ID!
    workspaceId: ID!
    title: String!
    kind: String!
    nodeCount: Int!
    "Epoch ms."
    updatedAt: Float!
    createdBy: String!
    thumbUrl: String
  }

  type ProjectEdge {
    cursor: String!
    node: Project!
  }

  type ProjectConnection {
    edges: [ProjectEdge!]!
    pageInfo: PageInfo!
  }

  enum AssetScope {
    MINE
    TEAM
    BUILTIN
    PUBLIC
    ALL
  }

  enum AssetKind {
    IMAGE
    VIDEO
    AUDIO
    TEXT
  }

  type AssetMeta {
    width: Int
    height: Int
    durationSec: Float
    "queued, pending (container unavailable) or done."
    processing: String
    tags: [String!]
  }

  type Asset {
    id: ID!
    kind: AssetKind!
    "mine, team, builtin, public or generated."
    source: String!
    name: String!
    "processing, ready or failed."
    status: String!
    mature: Boolean!
    size: Float
    contentType: String
    license: String
    projectId: ID
    createdAt: Float!
    "Signed (private) or public URL; null when the viewer may not see it."
    url: String
    thumbUrl: String
    waveformUrl: String
    meta: AssetMeta!
  }

  type AssetEdge {
    cursor: String!
    node: Asset!
  }

  type AssetConnection {
    edges: [AssetEdge!]!
    pageInfo: PageInfo!
  }
`;

function requireAuth(ctx: GraphQLContext) {
  if (!ctx.auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
  return ctx.auth;
}

function checkFirst(first: number | null | undefined, fallback: number): number {
  const n = first ?? fallback;
  if (n < 1 || n > 100) throw new GraphQLError("first must be between 1 and 100");
  return n;
}

/** Keyset cursors, the same encoding REST uses: base64 of `[time, id]`. */
function cursor(time: number, id: string): string {
  return btoa(JSON.stringify([time, id]));
}

export const projectsResolvers = {
  projects: async (_: unknown, args: { first?: number | null; after?: string | null }, ctx: GraphQLContext) => {
    const auth = requireAuth(ctx);
    const page = await listProjects(ctx.env, auth.workspaceId, checkFirst(args.first, 24), args.after);
    return { edges: page.items.map((node) => ({ cursor: cursor(node.updatedAt, node.id), node })), pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor } };
  },
  assets: async (
    _: unknown,
    args: { scope?: string | null; kind?: string | null; q?: string | null; first?: number | null; after?: string | null },
    ctx: GraphQLContext,
  ) => {
    const auth = requireAuth(ctx);
    const scope = (args.scope ?? "ALL").toLowerCase() as AssetScope;
    if (!ASSET_SCOPES.includes(scope)) throw new GraphQLError("Unknown scope");
    const page = await listAssets(ctx.env, auth, {
      scope,
      kind: args.kind ? (args.kind.toLowerCase() as "image" | "video" | "audio" | "text") : null,
      q: args.q,
      first: checkFirst(args.first, 48),
      after: args.after,
    });
    return {
      edges: page.items.map((a) => ({ cursor: cursor(a.createdAt, a.id), node: { ...a, kind: a.kind.toUpperCase() } })),
      pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
    };
  },
};
