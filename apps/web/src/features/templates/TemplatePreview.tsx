import { Button, cx, Dialog } from '@rolling/ui';
import { useId } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { formatUses } from './TemplatesPage';
import styles from './TemplatePreview.module.css';
import type { TemplateSummary } from './types';

/**
 * Template preview (Templates → a card): cover, what it makes, its cast and
 * lines, then Use template (Quick Create with this template) or Close.
 */
export function TemplatePreview({
  template,
  tone,
  ratio,
  onClose,
  onUse,
}: {
  template: TemplateSummary | null;
  tone: string;
  /** The aspect ratio it will be made in (the Aspect ratio facet). */
  ratio: string;
  onClose: () => void;
  onUse: (t: TemplateSummary) => void;
}) {
  const intl = useIntl();
  const titleId = useId();
  const t = template;
  return (
    <Dialog open={!!t} onOpenChange={(o) => !o && onClose()} bare labelledBy={titleId} label={t?.name ?? ''}>
      {t ? (
        <div className={styles.panel} data-testid="template-preview">
          <div className={styles.cover} style={{ background: tone, aspectRatio: t.coverAspect }}>
            <span className={styles.dur}>{intl.formatNumber(t.durationSec, { style: 'unit', unit: 'second', unitDisplay: 'narrow' })}</span>
          </div>
          <div className={styles.body}>
            <div className={styles.head}>
              <h2 id={titleId} className={styles.title}>
                {t.name}
              </h2>
              <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'templates.preview.close' })} onClick={onClose}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18 M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className={styles.desc}>{t.description ?? intl.formatMessage({ id: 'templates.preview.desc' })}</p>
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>
                  <FormattedMessage id="templates.facet.character" />
                </dt>
                <dd>
                  <FormattedMessage id="templates.badge.roles" values={{ n: t.roles }} />
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>
                  <FormattedMessage id="templates.facet.lines" />
                </dt>
                <dd>
                  <FormattedMessage id={t.hasLines ? 'templates.facet.lines.with' : 'templates.facet.lines.without'} />
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>
                  <FormattedMessage id="templates.facet.aspect" />
                </dt>
                <dd>{ratio}</dd>
              </div>
              <div className={styles.fact}>
                <dt>
                  <FormattedMessage id="templates.preview.used" />
                </dt>
                <dd>
                  <FormattedMessage id="templates.uses" values={{ uses: formatUses(intl, t.uses) }} />
                </dd>
              </div>
            </dl>
            <p className={styles.note}>
              <FormattedMessage id="templates.preview.note" />
            </p>
            <div className={styles.actions}>
              <Button variant="ghost" onClick={onClose}>
                <FormattedMessage id="templates.preview.cancel" />
              </Button>
              <Button variant="primary" className={cx('rl-press')} onClick={() => onUse(t)} autoFocus>
                <FormattedMessage id="templates.use" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
