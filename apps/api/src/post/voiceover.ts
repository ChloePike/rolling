/**
 * Imported voiceover (D-037): split a voice clip on its pauses (container
 * `/silences`, ffmpeg `silencedetect`) and, optionally, line the parts up with
 * the shots. One timeline patch; the editor picks it up like any remote edit.
 */
import { assignToShots, cutsFromSilences, SILENCE_DEFAULTS, splitOps, type Silence } from "@rolling/core/post";
import { applyOps, findClip, isCaptionClip, type MediaClip } from "@rolling/core/timeline";
import type { RoomCaller } from "../lib/access";
import { ApiError } from "../lib/errors";
import { signMediaUrl } from "../lib/mediaUrls";
import { editTimeline, readTimeline } from "./timeline";
import { ContainerUnavailable, postContainer } from "./seams";

export async function splitVoiceover(
  env: Env,
  input: { caller: RoomCaller; projectId: string; canvasId: string; clipId: string; assign: boolean; minSilence?: number; noiseDb?: number },
): Promise<{ revision: number; parts: string[]; silences: Silence[] }> {
  const { edl } = await readTimeline(env, input.projectId, input.canvasId, input.caller);
  const ref = findClip(edl, input.clipId);
  if (!ref || ref.track.kind !== "voice" || isCaptionClip(ref.clip) || !ref.clip.assetId) throw new ApiError(422, "VALIDATION_FAILED", "Pick a voice clip on the voice lane", { reason: "NOT_A_VOICE" });
  const clip = ref.clip as MediaClip;
  const a = await env.DB.prepare("SELECT r2_key, workspace_id, status FROM assets WHERE id = ?").bind(clip.assetId).first<{ r2_key: string; workspace_id: string | null; status: string }>();
  if (!a || a.workspace_id !== input.caller.workspaceId || a.status !== "ready") throw new ApiError(422, "VALIDATION_FAILED", "This voice clip is not ready yet", { reason: "NOT_READY" });
  const url = await signMediaUrl(env, a.r2_key, { workspaceId: a.workspace_id, expiresIn: 900, absolute: true });
  let silences: Silence[];
  try {
    const res = await postContainer()(env, "/silences", { url, start: clip.in, duration: clip.out - clip.in, noiseDb: input.noiseDb ?? SILENCE_DEFAULTS.noiseDb, minSilence: input.minSilence ?? SILENCE_DEFAULTS.minSilence }, 120_000);
    silences = ((await res.json()) as { silences: Silence[] }).silences.map((s) => ({ start: s.start + clip.in, end: s.end + clip.in }));
  } catch (err) {
    if (err instanceof ContainerUnavailable) throw new ApiError(503, "INTERNAL", "The media service is not available right now. Try again in a few minutes.", { reason: "renderer_unavailable" });
    throw err;
  }
  const cuts = cutsFromSilences(silences, { in: clip.in, out: clip.out });
  let parts: string[] = [clip.id];
  const done = await editTimeline(env, input.projectId, input.canvasId, input.caller, ({ edl: now }) => {
    const split = splitOps(now, input.clipId, cuts);
    if (!split) return null;
    parts = split.partIds;
    if (!input.assign) return split.ops.length ? { ops: split.ops } : null;
    const afterSplit = applyOps(now, split.ops);
    if (!afterSplit.ok) throw new ApiError(422, "VALIDATION_FAILED", afterSplit.error);
    const moves = assignToShots(afterSplit.edl, split.partIds);
    const ops = [...split.ops, ...moves];
    return ops.length ? { ops } : null;
  });
  return { revision: done?.revision ?? (await readTimeline(env, input.projectId, input.canvasId, input.caller)).revision, parts, silences };
}
