import { Button, Dialog, SegmentedControl, Switch, useToast } from '@rolling/ui';
import { useId, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { isApiError } from '@/lib/api/errors';
import { sendFeedback, type FeedbackKind } from './api';
import styles from './HelpDialog.module.css';

/**
 * Help and feedback (account menu). Help pages come with launch; until then
 * the dialog says so, links the legal pages and takes feedback (`POST /api/feedback { message, kind,
 * page, includeDiagnostics }`; the current path goes along as `page`).
 */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const fieldId = useId();
  const [text, setText] = useState('');
  const diagId = useId();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [diagnostics, setDiagnostics] = useState(true);
  const [state, setState] = useState<'idle' | 'sending'>('idle');
  const t = (id: string) => intl.formatMessage({ id });

  const send = async () => {
    if (!text.trim()) return;
    setState('sending');
    try {
      await sendFeedback({ message: text.trim(), kind, page: window.location.pathname, includeDiagnostics: diagnostics });
      setText('');
      onOpenChange(false);
      toast.show({ message: t('shell.help.sent') });
    } catch (e) {
      toast.show({ message: t(isApiError(e, 'RATE_LIMITED') ? 'shell.help.limited' : 'shell.help.failed') });
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
        <SegmentedControl<FeedbackKind>
          label={t('shell.help.kind')}
          value={kind}
          onValueChange={setKind}
          options={(['bug', 'idea', 'other'] as const).map((k) => ({ value: k, label: t(`shell.help.kind.${k}`) }))}
        />
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
        <div className={styles.diag}>
          <span id={diagId} className={styles.diagText}>
            <FormattedMessage id="shell.help.diagnostics" />
          </span>
          <Switch size="sm" checked={diagnostics} onCheckedChange={setDiagnostics} aria-labelledby={diagId} />
        </div>
        <LegalLinks className={styles.legal} linkClassName={styles.legalLink} onNavigate={() => onOpenChange(false)} />
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
