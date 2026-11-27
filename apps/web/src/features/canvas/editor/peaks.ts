/** Waveform peaks are sampled every 3px at 100px per second, i.e. `100 / 3` peaks per second (mock and real peaks). */
export const PEAKS_PER_SECOND = 100 / 3;

/** Tallest half-height a peak draws at in a 30px lane, in tenths of a pixel (the mock tracks top out near 13px). */
const MAX_TENTHS = 130;
/** Quietest bar still drawn, so silence reads as a thin line (as in the design). */
const MIN_TENTHS = 4;

/**
 * Lane peaks from a media.process waveform (`GET /api/assets/:id/waveform`: `peaks` 0..1 spread
 * over `durationSec`): tenths of a pixel of half-height, `PEAKS_PER_SECOND` per second of source.
 */
export function lanePeaks(peaks: readonly number[], durationSec: number | null): number[] {
  if (!peaks.length) return [0];
  const dur = durationSec && durationSec > 0 ? durationSec : peaks.length / PEAKS_PER_SECOND;
  const n = Math.max(1, Math.round(dur * PEAKS_PER_SECOND));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / n))] ?? 0;
    out.push(Math.max(MIN_TENTHS, Math.round(Math.max(0, Math.min(1, p)) * MAX_TENTHS)));
  }
  return out;
}
