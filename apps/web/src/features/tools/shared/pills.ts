import type { IntlShape } from 'react-intl';
import type { ComposerPill } from '../types';
import type { ToolIconName } from './icons';
import type { ToolCaps, ToolSettings } from './settings';

/**
 * Composer pills for the current settings: one per setting the model takes,
 * each labelled with its current value. Settings the model lacks have no pill.
 * Every pill opens the shared settings popover (ToolLayout).
 */
export function settingsPills(
  intl: IntlShape,
  s: ToolSettings,
  caps: ToolCaps,
  opts: { ratioIcon?: ToolIconName; ratioLabel?: (ratio: string) => string; count?: boolean; audio?: boolean } = {},
): ComposerPill[] {
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const out: ComposerPill[] = [];
  if (caps.ratios.length && s.ratio) out.push({ id: 'ratio', label: opts.ratioLabel ? opts.ratioLabel(s.ratio) : s.ratio === 'Auto' ? t('tools.pill.ratioAuto') : s.ratio, icon: opts.ratioIcon ?? 'ratio' });
  if (caps.durations.length && s.seconds) out.push({ id: 'duration', label: t('tools.seconds', { n: s.seconds }), icon: 'clock' });
  if (caps.resolutions.length && s.resolution) out.push({ id: 'res', label: s.resolution, icon: 'res' });
  if (caps.audio && opts.audio !== false) out.push({ id: 'audio', label: t(s.audio ? 'tools.pill.audio' : 'tools.pill.audioOff'), icon: 'wave' });
  if (opts.count && caps.counts.length > 1) out.push({ id: 'count', label: t('tools.pill.count', { n: s.count }), icon: 'count' });
  return out;
}

/** The run card tags for the same settings (ratio, length, resolution). */
export function settingsTags(intl: IntlShape, s: ToolSettings): string[] {
  return [s.ratio && s.ratio !== 'Auto' ? s.ratio : '', s.seconds ? intl.formatMessage({ id: 'tools.seconds' }, { n: s.seconds }) : '', s.resolution].filter(Boolean);
}
