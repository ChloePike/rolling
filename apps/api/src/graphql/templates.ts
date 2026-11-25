/** GraphQL reads for Templates: `templates(category, q, first)` and `template(id)`. Merged into the schema in `./index.ts`. */
import { GraphQLError } from "graphql";
import { getTemplateRow, listTemplates, templateDetail, TemplatesQuery, type TemplateDetail } from "../routes/templates";
import type { GraphQLContext } from "./index";

export const templatesTypeDefs = /* GraphQL */ `
  extend type Query {
    "Built-in and workspace templates, most used first (signed in)."
    templates(category: String, q: String, first: Int = 60): [Template!]!
    "One template with its graph (signed in)."
    template(id: ID!): Template
  }

  type TemplateSlot {
    "Node id in the template graph; the key of a fill in POST /api/projects { slots }."
    id: ID!
    "image, video, audio or text."
    kind: String!
    label: String!
    "assetId or text."
    param: String!
    required: Boolean!
    default: String
  }

  type Template {
    id: ID!
    name: String!
    description: String
    category: String
    "builtin or workspace."
    source: String!
    durationSec: Float!
    ratio: String!
    coverAspect: String!
    roles: Int!
    hasLines: Boolean!
    tags: [String!]!
    featured: Boolean!
    uses: Int!
    nodeCount: Int!
    skill: String
    coverUrl: String
    slots: [TemplateSlot!]!
    createdAt: Float!
    "The canvas graph as JSON ({ nodes, edges, groups }); only on template(id)."
    graph: String
  }
`;

function signedIn(ctx: GraphQLContext) {
  if (!ctx.auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
  return ctx.auth;
}

export const templatesResolvers = {
  templates: async (_: unknown, args: { category?: string | null; q?: string | null; first?: number | null }, ctx: GraphQLContext) => {
    const auth = signedIn(ctx);
    const parsed = TemplatesQuery.safeParse({ ...(args.category && { category: args.category }), ...(args.q && { q: args.q }), first: args.first ?? 60 });
    if (!parsed.success) throw new GraphQLError("Invalid templates query", { extensions: { code: "VALIDATION_FAILED" } });
    return (await listTemplates(ctx.env, auth.workspaceId, parsed.data)).items;
  },
  template: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
    const auth = signedIn(ctx);
    const row = await getTemplateRow(ctx.env, auth.workspaceId, args.id);
    if (!row) return null;
    const t: TemplateDetail = await templateDetail(ctx.env, row);
    return { ...t, graph: JSON.stringify(t.graph) };
  },
};
