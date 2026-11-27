/**
 * Server-side timeline edits for post-production (captions landing, extend and
 * lip-sync placements, voiceover split): read the timeline, build the change,
 * patch at that revision, retry on a conflict (someone edited meanwhile).
 */
import type { Edl, TimelineOp } from "@rolling/core/timeline";
import { projectRoom, type RoomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { isRoomError, unwrap } from "../lib/room";

export interface TimelineNow {
  revision: number;
  edl: Edl;
}

export async function readTimeline(env: Env, projectId: string, canvasId: string, caller: RoomCaller): Promise<TimelineNow> {
  const t = unwrap(await projectRoom(env, projectId).getTimeline(caller, canvasId)).timeline;
  return { revision: t.revision, edl: t.edl };
}

/** A change: ops on the current EDL, a whole new EDL, or nothing to do (null). */
export type TimelineChange = { ops: TimelineOp[] } | { edl: Edl } | null;

/**
 * Applies `build(current)` at the current revision; on CONFLICT reads again and
 * rebuilds (up to `tries`). Returns the new revision, or null when `build`
 * found nothing to do. Invalid changes throw 422.
 */
export async function editTimeline(env: Env, projectId: string, canvasId: string, caller: RoomCaller, build: (now: TimelineNow) => TimelineChange, tries = 4): Promise<{ revision: number; edl: Edl } | null> {
  const room = projectRoom(env, projectId);
  for (let i = 0; i < tries; i++) {
    const now = await readTimeline(env, projectId, canvasId, caller);
    const change = build(now);
    if (!change) return null;
    const ops: TimelineOp[] = "ops" in change ? change.ops : [{ op: "replaceEdl", edl: change.edl, baseRevision: now.revision }];
    if (!ops.length) return null;
    const r = await room.patchTimeline(caller, { canvasId, baseRevision: now.revision, ops });
    if (!isRoomError(r)) return { revision: r.timeline.revision, edl: r.timeline.edl };
    if (r.code === "CONFLICT") continue;
    unwrap(r);
  }
  throw new ApiError(409, "CONFLICT", "The timeline kept changing. Try again.");
}
