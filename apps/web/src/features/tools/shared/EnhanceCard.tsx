import { useIntl } from 'react-intl';
import type { EnhancePrompt } from '@/lib/models';
import { AsideCard } from './AsideCard';
import { ToolSwitch } from './Switch';
import styles from './ToolLayout.module.css';

/**
 * D-020 "Enhance prompt" in a tool's left panel: on/off for this run (starts
 * from Preferences), shown only when the run's model takes the gateway's prompt
 * expansion; disabled with "Not available yet" while the gateway refuses it.
 */
export function EnhanceCard({ enhance }: { enhance: EnhancePrompt }) {
  const intl = useIntl();
  if (enhance.state === null) return null;
  const unavailable = enhance.state === 'unavailable';
  const label = intl.formatMessage({ id: 'prompt.enhance.label' });
  return (
    <AsideCard row testId="enhance">
      <span className={styles.enhanceText}>
        <span className={styles.enhanceLabel}>{label}</span>
        <span className={styles.enhanceHint} data-testid="enhance-hint">
          {intl.formatMessage({ id: unavailable ? 'prompt.enhance.unavailable' : 'prompt.enhance.hint' })}
        </span>
      </span>
      <ToolSwitch on={!unavailable && enhance.on} label={label} disabled={unavailable} onToggle={() => enhance.set(!enhance.on)} />
    </AsideCard>
  );
}
