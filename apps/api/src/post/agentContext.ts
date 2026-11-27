/**
 * What post-production adds to the agent's context (D-035, D-037): the
 * workspace brand kit (colors, fonts, cards, tone) and, for a project with an
 * imported voiceover on its timeline, each voice clip's length and transcript,
 * so plans respect the brand and pace shots to the voice. Plain data.
 */
import { brandKitSummary } from "@rolling/core/post";
import { clipEnd, type MediaClip } from "@rolling/core/timeline";
import { projectRoom } from "../lib/access";
import { isRoomError } from "../lib/room";
import { loadBrandKit } from "./brandKit";

const MAX_TRANSCRIPT_CHARS = 1500;

export async function postContext(env: Env, input: { workspaceId: string; userId: string; projectId: string | null; canvasId: string | null }): Promise<{ brandKit: string | null; voiceover: string | null }> {
  let brandKit: string | null = null;
  try {
    // The context line adds its own "Brand kit:" label.
    brandKit = brandKitSummary(await loadBrandKit(env, input.workspaceId))?.slice("Brand kit: ".length) ?? null;
  } catch {
    brandKit = null;
  }
  let voiceover: string | null = null;
  if (input.projectId) {
    try {
      const r = await projectRoom(env, input.projectId).getTimeline({ userId: input.userId, workspaceId: input.workspaceId, canEdit: false }, input.canvasId ?? undefined);
      if (!isRoomError(r)) {
        const clips = r.timeline.edl.tracks.filter((t) => t.kind === "voice").flatMap((t) => t.clips as MediaClip[]).filter((c) => c.assetId);
        const lines: string[] = [];
        for (const c of clips.slice(0, 8)) {
          const a = await env.DB.prepare("SELECT name, source, meta FROM assets WHERE id = ? AND workspace_id = ?").bind(c.assetId, input.workspaceId).first<{ name: string; source: string; meta: string | null }>();
          if (!a || a.source === "generated") continue;
          let meta: { durationSec?: number; transcript?: { text?: string; language?: string | null } } = {};
          try {
            meta = a.meta ? JSON.parse(a.meta) : {};
          } catch {
            meta = {};
          }
          const len = Math.round((clipEnd(c) - c.start) * 10) / 10;
          const text = meta.transcript?.text ? ` Transcript${meta.transcript.language ? ` (${meta.transcript.language})` : ""}: “${meta.transcript.text.slice(0, MAX_TRANSCRIPT_CHARS)}”` : " No transcript yet.";
          lines.push(`- “${a.name}” at ${Math.round(c.start * 10) / 10} s for ${len} s (file ${meta.durationSec ? `${Math.round(meta.durationSec * 10) / 10} s` : "length unknown"}).${text}`);
        }
        if (lines.length) voiceover = `Imported voiceover on the voice lane (pace the shots to it):\n${lines.join("\n")}`;
      }
    } catch {
      voiceover = null;
    }
  }
  return { brandKit, voiceover };
}
