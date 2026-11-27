/**
 * GraphQL reads for agent threads: `agentThreads(surface, first)`, the caller's own recent
 * conversations on one surface (Home's "Recent conversations", so a Home thread follows the user
 * to any device). Only threads with a first message (a title) are listed. Merged in `./index.ts`.
 */
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "./index";

export const agentThreadsTypeDefs = /* GraphQL */ `
  extend type Query {
    "The signed-in user's agent threads on a surface (home, canvas, editor, tool) in this workspace, most recent first."
    agentThreads(surface: String!, first: Int = 10): [AgentThreadSummary!]!
  }

  type AgentThreadSummary {
    id: ID!
    projectId: ID
    surface: String!
    skill: String
    "The first message, cut to 80 characters."
    title: String!
    updatedAt: Float!
  }
`;

const SURFACES = new Set(["home", "canvas", "editor", "tool"]);

export const agentThreadsResolvers = {
  agentThreads: async (_: unknown, args: { surface: string; first?: number | null }, ctx: GraphQLContext) => {
    const auth = ctx.auth;
    if (!auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
    if (!SURFACES.has(args.surface)) throw new GraphQLError("Unknown surface", { extensions: { code: "VALIDATION_FAILED" } });
    const first = args.first ?? 10;
    if (first < 1 || first > 50) throw new GraphQLError("first must be between 1 and 50", { extensions: { code: "VALIDATION_FAILED" } });
    const rows = await ctx.env.DB.prepare(
      "SELECT id, project_id, surface, skill, title, updated_at FROM agent_threads WHERE workspace_id = ? AND created_by = ? AND surface = ? AND title IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
    )
      .bind(auth.workspaceId, auth.userId, args.surface, first)
      .all<{ id: string; project_id: string | null; surface: string; skill: string | null; title: string; updated_at: number }>();
    return rows.results.map((r) => ({ id: r.id, projectId: r.project_id, surface: r.surface, skill: r.skill, title: r.title, updatedAt: r.updated_at }));
  },
};
