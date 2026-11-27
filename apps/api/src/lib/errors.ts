import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Error codes shared with the client. Payment-related codes are listed in docs/api.md.
 * Keep this list in sync with the web client's error handling.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_CODE"
  | "CODE_EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  | "NO_PLAN"
  | "INSUFFICIENT_CREDITS"
  | "QUOTE_EXPIRED"
  | "MEMBER_LIMIT_REACHED"
  | "CONCURRENCY_LIMIT"
  | "SEAT_LIMIT_REACHED"
  | "TEAM_REQUIRED"
  | "SEATS_REQUIRED"
  | "SEATS_IN_USE"
  | "PAYMENT_FAILED"
  | "AGENT_ALLOWANCE_EXHAUSTED"
  | "HANDLE_TAKEN"
  | "OWNER_OF_TEAM"
  | "AVATAR_REJECTED"
  | "SAFETY_UNAVAILABLE"
  | "SUSPENDED"
  | "GATEWAY_UNAVAILABLE"
  | "NOT_IMPLEMENTED"
  | "INTERNAL";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; data: Record<string, unknown> };
}

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorEnvelope(code: ErrorCode, message: string, data: Record<string, unknown> = {}): ErrorEnvelope {
  return { error: { code, message, data } };
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  data: Record<string, unknown> = {},
) {
  return c.json(errorEnvelope(code, message, data), status);
}
