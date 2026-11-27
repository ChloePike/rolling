/** GraphQL read field for Activity (M4): `runs(filter, first, after)`. Merged into the schema in `./index.ts`. */
import { GraphQLError } from "graphql";
import { getRunView, listRuns, RunsFilter, type RunView } from "../runs/activity";
import type { GraphQLContext } from "./index";

export const runsTypeDefs = /* GraphQL */ `
  extend type Query {
    "Runs of the current workspace for Activity, newest first, with cost and refunds (signed in)."
    runs(filter: RunsFilter, first: Int = 30, after: String): RunConnection!
    "One run of the current workspace (signed in)."
    run(id: ID!): Run
  }

  input RunsFilter {
    "queued, running, done, partial, failed or canceled."
    status: String
    projectId: ID
    "Gateway model id."
    model: String
    "Epoch ms bounds on createdAt."
    from: Float
    to: Float
  }

  type RunConnection {
    nodes: [Run!]!
    stats: ActivityStats!
    pageInfo: RunPageInfo!
  }

  type RunPageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type ActivityStats {
    usedThisMonth: Int!
    usedLastMonth: Int!
    running: Int!
    "0..1 over the last 7 days; null without finished jobs."
    successRate: Float
    runsLast7Days: Int!
    refundedThisMonth: Int!
  }

  type Run {
    id: ID!
    ref: String!
    name: String!
    source: String!
    "Where the run was started: home, quick, remix, avatar, character, canvas or agent."
    surface: String!
    projectId: ID
    projectTitle: String
    params: String!
    status: String!
    progress: Float
    "Quoted credits while queued/running, charged credits after."
    credits: Int!
    quoted: Int!
    spent: Int!
    refunded: Int!
    error: String
    createdAt: Float!
    finishedAt: Float
    items: [RunItem!]!
    "quick (image/video), remix, avatar or character for tool runs; null for canvas runs."
    tool: String
    "The normalized promptSpec of a tool run, as JSON (null for canvas runs)."
    promptSpec: String
    "Canvas runs: the scope and nodes quoted."
    scope: String
    nodeIds: [ID!]
    retryOf: ID
    characterId: ID
    "Failed, canceled or skipped items can be quoted again (POST /api/runs/:id/retry)."
    retryable: Boolean!
  }

  type RunItem {
    ref: String!
    nodeId: ID
    title: String
    kind: String!
    model: String!
    modelName: String!
    status: String!
    jobId: ID
    progress: Float
    credits: Int!
    spent: Int
    refunded: Int!
    assetId: ID
    error: String
    errorCode: String
  }
`;

/** Field resolvers of `Run` (request split into GraphQL fields). */
export const runFieldResolvers = {
  Run: {
    promptSpec: (r: RunView) => (r.request && "promptSpec" in r.request ? JSON.stringify(r.request.promptSpec) : null),
    scope: (r: RunView) => (r.request && "scope" in r.request ? r.request.scope : null),
    nodeIds: (r: RunView) => (r.request && "scope" in r.request ? (r.request.nodeIds ?? null) : null),
  },
};

export const runsResolvers = {
  run: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
    if (!ctx.auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
    return getRunView(ctx.env, ctx.auth.workspaceId, args.id);
  },
  runs: async (
    _: unknown,
    args: { filter?: Record<string, unknown> | null; first?: number | null; after?: string | null },
    ctx: GraphQLContext,
  ) => {
    if (!ctx.auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
    const parsed = RunsFilter.safeParse({ ...(args.filter ?? {}), first: args.first ?? 30, ...(args.after && { after: args.after }) });
    if (!parsed.success) throw new GraphQLError("Invalid runs filter", { extensions: { code: "VALIDATION_FAILED" } });
    const page = await listRuns(ctx.env, ctx.auth.workspaceId, parsed.data);
    return { nodes: page.runs, stats: page.stats, pageInfo: { hasNextPage: page.nextCursor !== null, endCursor: page.nextCursor } };
  },
};
