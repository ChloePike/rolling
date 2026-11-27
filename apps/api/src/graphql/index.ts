/**
 * Read-only GraphQL endpoint (D-003). No mutations. Persisted queries and
 * depth/complexity limits are added before production traffic (M1+).
 */
import { createSchema, createYoga } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type { PublicItem } from "@rolling/db/d1";
import { LIBRARY_CATEGORIES, libraryItemAttribution } from "@rolling/core/library/categories";
import type { LibraryCategoryKey } from "@rolling/core/library/types";
import { encodeCursor, listPublicCategoryCounts, listPublicItems, listPublicSubs } from "@rolling/db/queries/publicItems";
import { publicMediaUrl } from "../routes/media";
import { mediaUrlFor } from "../lib/mediaUrls";
import type { SessionUser } from "../lib/session";
import type { AuthContext } from "../auth/context";
import { listPublicModels } from "../models/catalog";
import { billingResolvers, billingTypeDefs } from "./billing";
import { projectsResolvers, projectsTypeDefs } from "./projects";
import { runFieldResolvers, runsResolvers, runsTypeDefs } from "./runs";
import { templatesResolvers, templatesTypeDefs } from "./templates";
import { agentThreadsResolvers, agentThreadsTypeDefs } from "./agentThreads";

export interface GraphQLContext {
  env: Env;
  user: SessionUser | null;
  /** Same auth context as REST (null when signed out). */
  auth: AuthContext | null;
}

const typeDefs = /* GraphQL */ `
  type Query {
    health: Health!
    "Public-library items. Mature items (D-005) only for mature-allowed callers, with signed private image URLs."
    publicItems(category: String, sub: String, q: String, first: Int = 24, after: String): PublicItemConnection!
    "Sub-categories of a public-library category with item counts (non-mature; mature included for mature-allowed callers)."
    publicSubCategories(category: String!): [PublicFacet!]!
    "Public-library categories with item counts (non-mature; mature included for mature-allowed callers)."
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
    "featured, more or tool (picker placement)."
    placement: String!
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
    "Where the item comes from (D-004), e.g. CharaDB for CharaDB-hosted items."
    attribution: Attribution!
    "Cover image URL (first angle)."
    thumbUrl: String
    "Depth map URL of the cover angle, for pose items."
    depthUrl: String
    angles: [PublicAngle!]!
    "D-005: an 18+ item. Only ever returned to mature-allowed callers; its URLs are signed private media."
    mature: Boolean!
  }

  type Attribution {
    name: String!
    url: String
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

const LIBRARY_CATEGORY_KEYS = new Set<string>(LIBRARY_CATEGORIES.map((c) => c.key));

const licenseEnum = { "first-party": "FIRST_PARTY", cc0: "CC0", mit: "MIT" } as const;

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

interface RawAngle {
  name: string;
  r2Key: string;
  depthR2Key: string | null;
}

/** `angles` JSON written by the PoseWear importer: [{ name, r2Key, depthR2Key? }]. */
function parseAngleKeys(raw: string | null): RawAngle[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((a: { name?: unknown; r2Key?: unknown; depthR2Key?: unknown }) =>
      typeof a?.name === "string" && typeof a?.r2Key === "string"
        ? [{ name: a.name, r2Key: a.r2Key, depthR2Key: typeof a.depthR2Key === "string" ? a.depthR2Key : null }]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * URL of one library object for this item (D-008). Non-mature items: the public bucket's
 * host. Mature items (only ever resolved for mature-allowed callers): a signed, hour-aligned
 * URL on the private media host; they are never in the public bucket. A mature item that
 * somehow reaches a caller who is not allowed resolves to no URL.
 */
async function itemMediaUrl(item: PublicItem, key: string, ctx: GraphQLContext): Promise<string | null> {
  if (!item.mature) return publicMediaUrl(key, ctx.env.PUBLIC_MEDIA_BASE_URL);
  return mediaUrlFor(ctx.env, { key, workspaceId: null, mature: true }, { mayViewMature: ctx.auth?.matureAllowed === true });
}

async function itemAngles(item: PublicItem, ctx: GraphQLContext): Promise<{ name: string; url: string; depthUrl: string | null }[]> {
  const out = await Promise.all(
    parseAngleKeys(item.angles).map(async (a) => {
      const url = await itemMediaUrl(item, a.r2Key, ctx);
      const depthUrl = a.depthR2Key ? await itemMediaUrl(item, a.depthR2Key, ctx) : null;
      return url ? [{ name: a.name, url, depthUrl }] : [];
    }),
  );
  return out.flat();
}

/** D-005: whether this GraphQL caller may see mature public-library items. */
const includeMature = (ctx: GraphQLContext) => ctx.auth?.matureAllowed === true;

const resolvers = {
  Query: {
    health: (_: unknown, __: unknown, ctx: GraphQLContext) => ({ ok: true, environment: ctx.env.ENVIRONMENT }),
    publicSubCategories: async (_: unknown, args: { category: string }, ctx: GraphQLContext) =>
      (await listPublicSubs(ctx.env.DB, args.category, { includeMature: includeMature(ctx) })).map((r) => ({ key: r.sub, count: r.count })),
    publicCategories: async (_: unknown, __: unknown, ctx: GraphQLContext) =>
      (await listPublicCategoryCounts(ctx.env.DB, { includeMature: includeMature(ctx) })).map((r) => ({ key: r.category, count: r.count })),
    publicItems: async (
      _: unknown,
      args: { category?: string | null; sub?: string | null; q?: string | null; first?: number | null; after?: string | null },
      ctx: GraphQLContext,
    ) => {
      const first = args.first ?? 24;
      if (first < 1 || first > 100) throw new GraphQLError("first must be between 1 and 100");
      const page = await listPublicItems(ctx.env.DB, { ...args, first, includeMature: includeMature(ctx) });
      return {
        edges: page.items.map((node) => ({ cursor: encodeCursor(node), node })),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    models: (_: unknown, args: { kind?: "IMAGE" | "VIDEO" | "CHAT" | null }, ctx: GraphQLContext) =>
      listPublicModels(ctx.env, ctx.user, args.kind ? (args.kind.toLowerCase() as "image" | "video" | "chat") : null),
    ...billingResolvers,
    ...projectsResolvers,
    ...runsResolvers,
    ...templatesResolvers,
    ...agentThreadsResolvers,
  },
  ...runFieldResolvers,
  Model: {
    kind: (m: { kind: string }) => m.kind.toUpperCase(),
  },
  PublicItem: {
    license: (item: PublicItem) => licenseEnum[item.license],
    tags: (item: PublicItem) => parseTags(item.tags),
    attribution: (item: PublicItem) => {
      const known = LIBRARY_CATEGORY_KEYS.has(item.category);
      const a = known ? libraryItemAttribution(item.category as LibraryCategoryKey, item.id) : { name: "PoseWear", url: undefined };
      return { name: a.name, url: a.url ?? null };
    },
    mature: (item: PublicItem) => item.mature === true,
    angles: (item: PublicItem, _: unknown, ctx: GraphQLContext) => itemAngles(item, ctx),
    thumbUrl: async (item: PublicItem, _: unknown, ctx: GraphQLContext) => {
      const first = parseAngleKeys(item.angles)[0];
      return first ? itemMediaUrl(item, first.r2Key, ctx) : null;
    },
    depthUrl: (item: PublicItem, _: unknown, ctx: GraphQLContext) => (item.depthKey ? itemMediaUrl(item, item.depthKey, ctx) : null),
  },
};

export const yoga = createYoga<GraphQLContext>({
  schema: createSchema<GraphQLContext>({ typeDefs: [typeDefs, billingTypeDefs, projectsTypeDefs, runsTypeDefs, templatesTypeDefs, agentThreadsTypeDefs], resolvers }),
  graphqlEndpoint: "/api/graphql",
  landingPage: false,
  graphiql: (_req, ctx) => ctx.env.ENVIRONMENT === "development",
  fetchAPI: { Response, Request, Headers, ReadableStream, URL },
});
