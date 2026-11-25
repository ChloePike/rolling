/**
 * Tool controls that have no request field of their own reach real runs as
 * short English direction lines appended to the prompt (the model reads the
 * prompt, not the UI): Avatar persona, expression and setting; Remix motion,
 * outfit target and the per-shot fields. Prompt text, not UI copy.
 */

/** Avatar: the presenting style, expression and setting of the speaker. */
export function avatarHints(o: { persona?: string; emotion?: string; setting?: { keepPhoto: true } | { scene: string } }): string[] {
  const out: string[] = [];
  if (o.persona?.trim()) out.push(`Presenting style: ${o.persona.trim()}.`);
  if (o.emotion?.trim()) out.push(`Expression: ${o.emotion.trim().toLowerCase()}.`);
  if (o.setting) out.push('keepPhoto' in o.setting ? 'Keep the background of the photo.' : `Setting: ${o.setting.scene.trim()}.`);
  return out;
}

/** Remix: motion strength (1–10) and which character wears the new outfit. */
export function remixHints(o: { motion?: number; outfitFor?: string | null }): string[] {
  const out: string[] = [];
  if (o.motion !== undefined) out.push(`Motion intensity: ${Math.round(o.motion)} of 10.`);
  if (o.outfitFor) out.push(`Apply the new outfit only to ${o.outfitFor}.`);
  return out;
}

/** Remix shot fields (camera, line, actions) → one shot prompt; empty when nothing was written. */
export function shotPrompt(fields: ReadonlyArray<[label: string, value: string]>): string {
  return fields
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}: ${v.trim()}`)
    .join('. ');
}
