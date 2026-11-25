/**
 * Calling the CreditAccount Durable Object from routes and workflows. Other
 * areas (runs, agent) use these helpers rather than the stub directly.
 */
import type { LedgerErrorCode, LedgerOutcome, QuoteItemInput, QuoteResult } from "@rolling/core/credits";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, type ErrorCode } from "../lib/errors";
import { loadCatalog } from "../models/catalog";

export function creditAccount(env: Env, workspaceId: string) {
  return env.CREDITS.get(env.CREDITS.idFromName(workspaceId));
}

const STATUS: Record<LedgerErrorCode, [ContentfulStatusCode, ErrorCode]> = {
  NO_PLAN: [402, "NO_PLAN"],
  INSUFFICIENT_CREDITS: [402, "INSUFFICIENT_CREDITS"],
  MEMBER_LIMIT_REACHED: [403, "MEMBER_LIMIT_REACHED"],
  CONCURRENCY_LIMIT: [429, "CONCURRENCY_LIMIT"],
  QUOTE_EXPIRED: [409, "QUOTE_EXPIRED"],
  NOT_FOUND: [404, "NOT_FOUND"],
  JOB_CLOSED: [409, "CONFLICT"],
  IDEMPOTENCY_CONFLICT: [409, "CONFLICT"],
  BAD_REQUEST: [400, "BAD_REQUEST"],
  AGENT_ALLOWANCE_EXHAUSTED: [429, "AGENT_ALLOWANCE_EXHAUSTED"],
};

/** The value of a CreditAccount outcome, or the matching ApiError (error envelope codes from docs/api.md). */
export function unwrapLedger<T>(outcome: LedgerOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  const [status, code] = STATUS[outcome.error.code] ?? [500, "INTERNAL"];
  const data = outcome.error.code === "JOB_CLOSED" || outcome.error.code === "IDEMPOTENCY_CONFLICT" ? { reason: outcome.error.code, ...outcome.error.data } : outcome.error.data;
  throw new ApiError(status, code, outcome.error.message, data);
}

/** Quotes items over the synced catalog (only the referenced models cross the RPC boundary). */
export async function quoteCredits(env: Env, workspaceId: string, items: QuoteItemInput[]): Promise<QuoteResult> {
  const ids = new Set(items.map((i) => i.modelId));
  const catalog = (await loadCatalog(env)).models.filter((m) => ids.has(m.id));
  return unwrapLedger(await creditAccount(env, workspaceId).quote(items, catalog));
}
