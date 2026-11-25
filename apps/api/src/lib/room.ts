/** Maps ProjectRoom RPC errors to the REST error envelope. */
import type { RoomError } from "../do/ProjectRoom";
import { ApiError } from "./errors";

export function roomFailure(err: RoomError): never {
  switch (err.code) {
    case "NOT_FOUND":
      throw new ApiError(404, "NOT_FOUND", err.message);
    case "FORBIDDEN":
      throw new ApiError(403, "FORBIDDEN", err.message);
    case "CONFLICT":
      throw new ApiError(409, "CONFLICT", err.message, err.timeline ? { timeline: err.timeline } : { snapshot: err.snapshot });
    case "REFUSED":
      throw new ApiError(422, "VALIDATION_FAILED", err.message, { refusal: err.refusal });
    case "TIMELINE_INVALID":
      throw new ApiError(422, "VALIDATION_FAILED", err.message, { reason: "TIMELINE_INVALID" });
    case "NOTHING_TO_UNDO":
    case "NOTHING_TO_REDO":
      throw new ApiError(409, "CONFLICT", err.message, { reason: err.code });
  }
}

/** Narrows an RPC result: returns the success value or throws the mapped ApiError. */
export function unwrap<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  if (result.ok) return result as Extract<R, { ok: true }>;
  return roomFailure(result as unknown as RoomError);
}

export function isRoomError(v: unknown): v is RoomError {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

/** For RPCs that return a value or a RoomError (no `ok: true` on success). */
export function orFail<R>(result: R): Exclude<R, { ok: false }> {
  if (isRoomError(result)) return roomFailure(result);
  return result as Exclude<R, { ok: false }>;
}
