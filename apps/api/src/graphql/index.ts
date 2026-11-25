/**
 * Read-only GraphQL endpoint (D-003). No mutations. Persisted queries and
 * depth/complexity limits are added before production traffic (M1+).
 */
import { createSchema, createYoga } from "graphql-yoga";
import { GraphQLError } from "graphql";
import type { PublicItem } from "@rolling/db/d1";
import { encodeCursor, listPublicItems } from "@rolling/db/queries/publicItems";
import type { SessionUser } from "../lib/session";

export interface GraphQLContext {
  env: Env;
  user: SessionUser | null;
}

const typeDefs = /* GraphQL */ `
  type Query {
    health: Health!
    publicItems(category: String, q: String, first: Int = 24, after: String): PublicItemConnection!
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

const resolvers = {
  Query: {
    health: (_: unknown, __: unknown, ctx: GraphQLContext) => ({ ok: true, environment: ctx.env.ENVIRONMENT }),
    publicItems: async (
      _: unknown,
      args: { category?: string | null; q?: string | null; first?: number | null; after?: string | null },
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
  },
  PublicItem: {
    license: (item: PublicItem) => licenseEnum[item.license],
    tags: (item: PublicItem) => parseTags(item.tags),
  },
};

export const yoga = createYoga<GraphQLContext>({
  schema: createSchema<GraphQLContext>({ typeDefs, resolvers }),
  graphqlEndpoint: "/api/graphql",
  landingPage: false,
  graphiql: (_req, ctx) => ctx.env.ENVIRONMENT === "development",
  fetchAPI: { Response, Request, Headers, ReadableStream, URL },
});
