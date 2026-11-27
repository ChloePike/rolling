/**
 * The frame icon for an aspect ratio, so a ratio pill's icon matches its label:
 * `wide` (landscape, e.g. 16:9), `ratio` (portrait, e.g. 9:16) or `square` (1:1).
 * Every icon set (prompt, tools, canvas) has these three names. Unknown or
 * "Auto"/"adaptive" ratios keep the portrait frame the designs use.
 */
export type RatioIconName = 'ratio' | 'wide' | 'square';

export function ratioIcon(ratio: string | null | undefined): RatioIconName {
  const m = ratio ? /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(ratio) : null;
  if (!m) return 'ratio';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return 'ratio';
  return w === h ? 'square' : w > h ? 'wide' : 'ratio';
}
