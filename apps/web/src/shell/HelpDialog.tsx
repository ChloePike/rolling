import { Button, Dialog, useToast } from '@rolling/ui';
import { useId, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { sendFeedback } from './api';
import styles from './HelpDialog.module.css';

/**
 * Help and feedback (account menu). Help pages come with launch; until then
 * the dialog says so and takes feedback (`POST /api/feedback`, mocked).
 */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const fieldId = useId();
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending'>('idle');
  const t = (id: string) => intl.formatMessage({ id });

  const send = async () => {
    if (!text.trim()) return;
    setState('sending');
    try {
      await sendFeedback(text.trim());
      setText('');
      onOpenChange(false);
      toast.show({ message: t('shell.help.sent') });
    } catch {
      toast.show({ message: t('shell.help.failed') });
    } finally {
      setState('idle');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('shell.account.help.title')} closeLabel={t('shell.help.close')} width={440}>
      <div className={styles.body}>
        <p className={styles.text}>
          <FormattedMessage id="shell.help.body" />
        </p>
        <label htmlFor={fieldId} className={styles.label}>
          <FormattedMessage id="shell.help.feedback" />
        </label>
        <textarea
          id={fieldId}
          rows={4}
          className={styles.field}
          placeholder={t('shell.help.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <FormattedMessage id="shell.help.cancel" />
          </Button>
          <Button variant="primary" disabled={!text.trim() || state === 'sending'} aria-busy={state === 'sending' || undefined} onClick={() => void send()}>
            <FormattedMessage id={state === 'sending' ? 'shell.help.sending' : 'shell.help.send'} />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
