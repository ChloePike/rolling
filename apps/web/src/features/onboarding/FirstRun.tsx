import { Dialog } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { FormattedDate, FormattedMessage, useIntl } from 'react-intl';
import { useTemplates } from '@/features/templates/api';
import { useSession } from '@/lib/session';
import { firstRunState, MAKE_KINDS, rememberFirstRun, templatesFor, type MakeKind } from './firstRun';
import styles from './FirstRun.module.css';

type Start = { kind: 'template'; id: string; name: string } | { kind: 'brief'; text: string };

const TOTAL = 3;

/**
 * First-run after sign-up (D-022): pick what you make, then a template or a
 * brief, then where the result shows up. Shown once to a non-member on an
 * active trial; Skip (or Esc) and finishing are both remembered. Nothing is
 * spent here: a template opens in Quick Create, a brief lands in Home's prompt
 * box (`onBrief`), and every run still shows its cost first.
 */
export function FirstRun({ onBrief }: { onBrief: (brief: string) => void }) {
  const session = useSession();
  const userId = session.user?.id ?? null;
  const [dismissed, setDismissed] = useState(false);
  const eligible = session.status === 'signedIn' && !!userId && session.trial?.status === 'active';
  if (!eligible || !userId) return null;
  const open = !dismissed && firstRunState(userId) === null;
  return <FirstRunDialog open={open} userId={userId} onClose={() => setDismissed(true)} onBrief={onBrief} />;
}

function FirstRunDialog({ open, userId, onClose, onBrief }: { open: boolean; userId: string; onClose: () => void; onBrief: (brief: string) => void }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { trial } = useSession();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const [step, setStep] = useState(1);
  const [make, setMake] = useState<MakeKind | null>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [brief, setBrief] = useState('');
  const { data } = useTemplates();
  const suggestions = useMemo(() => (make ? templatesFor(make, [...data.featured, ...data.items.filter((i) => !data.featured.some((f) => f.id === i.id))]) : []), [make, data]);

  const close = (state: 'done' | 'skipped') => {
    rememberFirstRun(userId, state);
    onClose();
  };
  const pickMake = (k: MakeKind) => {
    setMake(k);
    const text = t(`trial.onboarding.brief.${k}`);
    setBrief(text);
    setStart({ kind: 'brief', text });
  };
  const finish = () => {
    if (!start) return;
    close('done');
    if (start.kind === 'template') void navigate({ to: '/create/quick', search: { template: start.id } });
    else onBrief(start.text);
  };

  const titleId = `trial.onboarding.${step === 1 ? 'kind' : step === 2 ? 'start' : 'result'}.title`;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : close('skipped'))} title={t(titleId)} width={480} dismissOnBackdrop={false}>
      <div className={styles.panel} data-testid="first-run" data-step={step}>
        <span className={styles.step}>
          <FormattedMessage id="trial.onboarding.step" values={{ n: step, total: TOTAL }} />
        </span>
        {step === 1 ? (
          <>
            <p className={styles.sub}>
              <FormattedMessage id="trial.onboarding.kind.sub" />
            </p>
            <div className={styles.kinds} role="radiogroup" aria-label={t('trial.onboarding.kind.title')}>
              {MAKE_KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={make === k} className={styles.kind} data-kind={k} onClick={() => pickMake(k)}>
                  <span className={styles.kindName}>
                    <FormattedMessage id={`trial.onboarding.kind.${k}`} />
                  </span>
                  <span className={styles.kindDesc}>
                    <FormattedMessage id={`trial.onboarding.kind.${k}.desc`} />
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : step === 2 ? (
          <>
            <p className={styles.sub}>
              <FormattedMessage id="trial.onboarding.start.sub" />
            </p>
            <span className={styles.label}>
              <FormattedMessage id="trial.onboarding.start.templates" />
            </span>
            {suggestions.length ? (
              <div className={styles.templates} role="radiogroup" aria-label={t('trial.onboarding.start.templates')}>
                {suggestions.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    role="radio"
                    aria-checked={start?.kind === 'template' && start.id === tpl.id}
                    className={styles.template}
                    data-template={tpl.id}
                    onClick={() => setStart({ kind: 'template', id: tpl.id, name: tpl.name })}
                  >
                    <span className={styles.templateName}>{tpl.name}</span>
                    <span className={styles.templateMeta}>{intl.formatNumber(tpl.durationSec, { style: 'unit', unit: 'second', unitDisplay: 'narrow' })}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className={styles.empty}>
                <FormattedMessage id="trial.onboarding.start.noTemplates" />
              </span>
            )}
            <label className={styles.label} htmlFor="first-run-brief">
              <FormattedMessage id="trial.onboarding.start.brief" />
            </label>
            <textarea
              id="first-run-brief"
              className={styles.brief}
              value={brief}
              placeholder={t('trial.onboarding.start.briefPlaceholder')}
              data-picked={start?.kind === 'brief'}
              onFocus={() => setStart({ kind: 'brief', text: brief })}
              onChange={(e) => {
                setBrief(e.target.value);
                setStart({ kind: 'brief', text: e.target.value });
              }}
            />
          </>
        ) : (
          <>
            <p className={styles.sub}>
              <FormattedMessage id="trial.onboarding.result.sub" />
            </p>
            <p className={styles.note}>
              {start?.kind === 'template' ? (
                <FormattedMessage id="trial.onboarding.result.template" values={{ name: start.name }} />
              ) : (
                <FormattedMessage id="trial.onboarding.result.brief" />
              )}
            </p>
            {trial ? (
              <p className={styles.note} data-testid="first-run-credits">
                <FormattedMessage
                  id="trial.onboarding.result.credits"
                  values={{ remaining: trial.remaining, date: <FormattedDate value={trial.expiresAt} month="short" day="numeric" /> }}
                />
              </p>
            ) : null}
          </>
        )}
        <div className={styles.footer}>
          <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => close('skipped')} data-testid="first-run-skip">
            <FormattedMessage id="trial.onboarding.skip" />
          </button>
          <span className={styles.spacer} />
          {step > 1 ? (
            <button type="button" className={styles.btn} onClick={() => setStep(step - 1)}>
              <FormattedMessage id="trial.onboarding.back" />
            </button>
          ) : null}
          {step < TOTAL ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              disabled={step === 1 ? !make : !start || (start.kind === 'brief' && !start.text.trim())}
              onClick={() => setStep(step + 1)}
              data-testid="first-run-next"
            >
              <FormattedMessage id="trial.onboarding.next" />
            </button>
          ) : (
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={finish} data-testid="first-run-finish">
              <FormattedMessage id={start?.kind === 'template' ? 'trial.onboarding.result.openTemplate' : 'trial.onboarding.result.useBrief'} />
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
