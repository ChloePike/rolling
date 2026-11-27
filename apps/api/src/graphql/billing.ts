/** GraphQL read fields for billing (M2): `billing` and `ledger`. Merged into the schema in `./index.ts`. */
import { GraphQLError } from "graphql";
import { billingSummary, encodeLedgerCursor, listLedger } from "../billing/read";
import { ApiError } from "../lib/errors";
import type { GraphQLContext } from "./index";

export const billingTypeDefs = /* GraphQL */ `
  extend type Query {
    "Plan, renewal, balance split and auto top-up of the current workspace (signed in)."
    billing: Billing!
    "Mirrored credit ledger of the current workspace, newest first (signed in)."
    ledger(first: Int = 25, after: String): LedgerConnection!
  }

  type Billing {
    "starter, plus, pro or team; null without an active plan."
    plan: String
    "Team (D-013): purchased seats and seats in use (members + pending invites); null on personal plans."
    seats: Seats
    "month or year."
    interval: String
    "Stripe subscription status, or null without a subscription."
    status: String
    "Next renewal (epoch ms); null when the plan ends at period end."
    renewsAt: Float
    cancelAtPeriodEnd: Boolean!
    periodEnd: Float
    balance: CreditBalance!
    autoTopUp: AutoTopUp
  }

  type Seats {
    purchased: Int!
    used: Int!
  }

  type CreditBalance {
    plan: Int!
    purchased: Int!
    held: Int!
    "When plan credits expire (epoch ms)."
    planExpiresAt: Float
  }

  type AutoTopUp {
    enabled: Boolean!
    thresholdCredits: Int!
    amountCents: Int!
  }

  type LedgerLine {
    id: ID!
    "grant, purchase, hold, settle, release, refund, expire or adjust."
    kind: String!
    "plan, purchased or trial (D-022)."
    bucket: String!
    "Signed credits (see docs/api.md)."
    amount: Int!
    userId: String
    runId: String
    jobId: String
    stripeRef: String
    note: String
    createdAt: Float!
  }

  type LedgerEdge {
    cursor: String!
    node: LedgerLine!
  }

  type LedgerConnection {
    edges: [LedgerEdge!]!
    pageInfo: PageInfo!
  }
`;

function workspaceOf(ctx: GraphQLContext): string {
  if (!ctx.auth) throw new GraphQLError("Sign in required", { extensions: { code: "UNAUTHENTICATED" } });
  return ctx.auth.workspaceId;
}

export const billingResolvers = {
  billing: (_: unknown, __: unknown, ctx: GraphQLContext) => billingSummary(ctx.env, workspaceOf(ctx)),
  ledger: async (_: unknown, args: { first?: number | null; after?: string | null }, ctx: GraphQLContext) => {
    const first = args.first ?? 25;
    if (first < 1 || first > 100) throw new GraphQLError("first must be between 1 and 100");
    try {
      const page = await listLedger(ctx.env, workspaceOf(ctx), first, args.after ?? null);
      return {
        edges: page.lines.map((node) => ({ cursor: encodeLedgerCursor(node.createdAt, node.id), node })),
        pageInfo: page.pageInfo,
      };
    } catch (e) {
      if (e instanceof ApiError) throw new GraphQLError(e.message, { extensions: { code: e.code } });
      throw e;
    }
  },
};
