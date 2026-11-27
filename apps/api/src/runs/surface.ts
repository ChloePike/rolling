/**
 * Where a run was started (migration 0025, `runs.surface`), for Activity's Source column
 * and the run name. The client says which surface quoted it; the server keeps it consistent
 * with what was quoted (a Remix spec is always `remix`, a canvas scope `canvas` or `agent`).
 */
import { z } from "zod";
import type { PromptSpec } from "@rolling/core/generation";

export const RUN_SURFACES = ["home", "quick", "remix", "avatar", "character", "canvas", "agent"] as const;
export type RunSurface = (typeof RUN_SURFACES)[number];
export const RunSurfaceSchema = z.enum(RUN_SURFACES);

/** The surface stored for a run, from what was quoted and the surface the client named. */
export function runSurface(quoted: { promptSpec: Pick<PromptSpec, "kind"> } | { scope: string }, requested?: RunSurface): RunSurface {
  if ("promptSpec" in quoted) {
    const kind = quoted.promptSpec.kind;
    if (kind === "remix" || kind === "avatar" || kind === "character") return kind;
    // A plain image or video: Home's prompt box (or the Home agent) or Quick Create.
    return requested === "home" || requested === "agent" ? requested : "quick";
  }
  return requested === "agent" ? "agent" : "canvas";
}

/** Best guess for runs before 0025 (no surface): the tool, else Quick Create for a spec run, else the canvas. */
export function guessSurface(row: { surface?: string | null; tool: string | null; source: string }): RunSurface {
  if (row.surface && (RUN_SURFACES as readonly string[]).includes(row.surface)) return row.surface as RunSurface;
  if (row.tool === "remix" || row.tool === "avatar" || row.tool === "character") return row.tool;
  if (row.tool === "quick" || row.source === "quickCreate") return "quick";
  return "canvas";
}

const TITLE_MAX = 60;

/**
 * Run name from its prompt: the first line, whitespace collapsed, `@[Name]` mentions as names,
 * cut at a word under 60 characters with an ellipsis. Empty when there is no prompt.
 */
export function promptTitle(prompt: string): string {
  const line = prompt
    .replace(/@\[([^\]]+)\]/g, "$1")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return "";
  const flat = line.replace(/\s+/g, " ");
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** Name of a spec run: its title, else its prompt (image and video), else the default item title. */
export function specRunTitle(spec: Pick<PromptSpec, "kind" | "title" | "prompt">, fallback: string): string {
  if (spec.title) return spec.title;
  if (spec.kind === "image" || spec.kind === "video") return promptTitle(spec.prompt) || fallback;
  return fallback;
}
