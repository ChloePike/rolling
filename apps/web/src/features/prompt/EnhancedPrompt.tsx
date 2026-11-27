import { useToast } from '@rolling/ui';
import { useIntl } from 'react-intl';
import { PromptIcon } from './icons';
import styles from './EnhancedPrompt.module.css';

/**
 * D-020: the prompt that rendered when the gateway rewrote the user's prompt
 * ("Enhanced prompt"), with a copy button. Run cards and canvas versions;
 * the result viewers show it in their prompt column.
 */
export function EnhancedPrompt({ text, testId = 'enhanced-prompt' }: { text: string; testId?: string }) {
  const intl = useIntl();
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ message: intl.formatMessage({ id: 'prompt.enhanced.copied' }) });
    } catch {
      toast.show({ message: intl.formatMessage({ id: 'prompt.enhanced.copyFailed' }) });
    }
  };
  return (
    <div className={styles.root} data-testid={testId}>
      <div className={styles.head}>
        <span className={styles.label}>{intl.formatMessage({ id: 'prompt.enhanced.title' })}</span>
        <button type="button" className={styles.copy} onClick={() => void copy()} aria-label={intl.formatMessage({ id: 'prompt.enhanced.copy' })}>
          <PromptIcon name="copy" size={13} />
        </button>
      </div>
      <p className={styles.text}>{text}</p>
    </div>
  );
}
