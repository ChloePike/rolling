/**
 * Read-only GraphQL endpoint (D-003). No mutations. Persisted queries and
 * depth/complexity limits are added before production traffic (M1+).
 */
import { createSchema, createYoga } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type { PublicItem } from "@rolling/db/d1";
import { encodeCursor, listPublicCategoryCounts, listPublicItems, listPublicSubs } from "@rolling/db/queries/publicItems";
import { publicMediaUrl } from "../routes/media";
import type { SessionUser } from "../lib/session";
import { listPublicModels } from "../models/catalog";

export interface GraphQLContext {
  env: Env;
  user: SessionUser | null;
}

const typeDefs = /* GraphQL */ `
  type Query {
    health: Health!
    publicItems(category: String, sub: String, q: String, first: Int = 24, after: String): PublicItemConnection!
    "Sub-categories of a public-library category with item counts (non-mature)."
    publicSubCategories(category: String!): [PublicFacet!]!
    "Public-library categories with item counts (non-mature)."
    publicCategories: [PublicFacet!]!
    "Synced model catalog (D-002). Mature-only models only for callers allowed to see them (D-005)."
    models(kind: ModelKind): [Model!]!
  }

  enum ModelKind {
    IMAGE
    VIDEO
    CHAT
  }

  type Model {
    id: ID!
    kind: ModelKind!
    name: String!
    tags: [String!]!
    default: Boolean!
    auto: Boolean!
    mature: Boolean!
    matureOnly: Boolean!
    requiresIdentitySafety: Boolean!
    substituteFor: String
    operations: [String!]!
    seconds: SecondsRange
    defaultSeconds: Int
    resolutions: [String!]!
    defaultResolution: String
    ratios: [String!]!
    audio: Boolean!
    lipSync: Boolean!
    limits: ModelLimits!
    credits: [CreditSample!]!
  }

  type SecondsRange {
    min: Int!
    max: Int!
    allowed: [Int!]
  }

  type ModelLimits {
    referenceImages: Int!
    referenceVideos: Int!
    referenceAudios: Int!
    inputImages: Int!
    imagesPerRequest: Int!
  }

  "Indicative credits for 5 s of video (or the model default) or one image, per resolution."
  type CreditSample {
    resolution: String
    seconds: Int
    credits: Int!
  }

  type Health {
    ok: Boolean!
    environment: String!
  }

  enum License {
    FIRST_PARTY
    CC0
    MIT
  }

  type PublicItem {
    id: ID!
    category: String!
    sub: String
    title: String!
    promptEn: String
    tags: [String!]!
    assetId: ID!
    license: License!
    source: String!
    "Cover image URL (first angle)."
    thumbUrl: String
    "Depth map URL of the cover angle, for pose items."
    depthUrl: String
    angles: [PublicAngle!]!
  }

  type PublicAngle {
    name: String!
    url: String!
    depthUrl: String
  }

  type PublicFacet {
    key: String!
    count: Int!
  }

  type PublicItemEdge {
    cursor: String!
    node: PublicItem!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type PublicItemConnection {
    edges: [PublicItemEdge!]!
    pageInfo: PageInfo!
  }
`;

const licenseEnum = { "first-party": "FIRST_PARTY", cc0: "CC0", mit: "MIT" } as const;

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** `angles` JSON written by the PoseWear importer: [{ name, r2Key, depthR2Key? }]. */
function parseAngles(raw: string | null): { name: string; url: string; depthUrl: string | null }[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((a: { name?: unknown; r2Key?: unknown; depthR2Key?: unknown }) =>
      typeof a?.name === "string" && typeof a?.r2Key === "string"
        ? [
            {
              name: a.name,
              url: publicMediaUrl(a.r2Key),
              depthUrl: typeof a.depthR2Key === "string" ? publicMediaUrl(a.depthR2Key) : null,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

const resolvers = {
  Query: {
    health: (_: unknown, __: unknown, ctx: GraphQLContext) => ({ ok: true, environment: ctx.env.ENVIRONMENT }),
    publicSubCategories: async (_: unknown, args: { category: string }, ctx: GraphQLContext) =>
      (await listPublicSubs(ctx.env.DB, args.category)).map((r) => ({ key: r.sub, count: r.count })),
    publicCategories: async (_: unknown, __: unknown, ctx: GraphQLContext) =>
      (await listPublicCategoryCounts(ctx.env.DB)).map((r) => ({ key: r.category, count: r.count })),
    publicItems: async (
      _: unknown,
      args: { category?: string | null; sub?: string | null; q?: string | null; first?: number | null; after?: string | null },
      ctx: GraphQLContext,
    ) => {
      const first = args.first ?? 24;
      if (first < 1 || first > 100) throw new GraphQLError("first must be between 1 and 100");
      const page = await listPublicItems(ctx.env.DB, { ...args, first });
      return {
        edges: page.items.map((node) => ({ cursor: encodeCursor(node), node })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    models: (_: unknown, args: { kind?: "IMAGE" | "VIDEO" | "CHAT" | null }, ctx: GraphQLContext) =>
      listPublicModels(ctx.env, ctx.user, args.kind ? (args.kind.toLowerCase() as "image" | "video" | "chat") : null),
  },
  Model: {
    kind: (m: { kind: string }) => m.kind.toUpperCase(),
  },
  PublicItem: {
    license: (item: PublicItem) => licenseEnum[item.license],
    tags: (item: PublicItem) => parseTags(item.tags),
    angles: (item: PublicItem) => parseAngles(item.angles),
    thumbUrl: (item: PublicItem) => parseAngles(item.angles)[0]?.url ?? null,
    depthUrl: (item: PublicItem) => (item.depthKey ? publicMediaUrl(item.depthKey) : null),
  },
};

export const yoga = createYoga<GraphQLContext>({
  schema: createSchema<GraphQLContext>({ typeDefs, resolvers }),
  graphqlEndpoint: "/api/graphql",
  landingPage: false,
  graphiql: (_req, ctx) => ctx.env.ENVIRONMENT === "development",
  fetchAPI: { Response, Request, Headers, ReadableStream, URL },
});
