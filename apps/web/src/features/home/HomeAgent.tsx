import { cx } from '@rolling/ui';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { PlanOption } from '@/features/overlays/agent';
import styles from './HomeAgent.module.css';

export interface HomeAgentState {
  /** The brief as sent. */
  brief: string;
  /** Streaming or final reply text. */
  text: string;
  pending: boolean;
  /** Plan proposal of the turn (2–3 options), or null. */
  plan: { proposalId: string; options: PlanOption[] } | null;
  /** Error or notice line (allowance, rate limit, safety). */
  notice: string | null;
}

/**
 * Home Agent mode answer (canvas-flow steps 1–2): the agent's reply and its
 * plan options with estimates; Build on canvas applies the picked option as a
 * new project (no spend) and opens it.
 */
export function HomeAgent({ state, building, onBuild, onDismiss }: { state: HomeAgentState; building: boolean; onBuild: (optionIndex: number) => void; onDismiss: () => void }) {
  const intl = useIntl();
  const [pick, setPick] = useState(0);
  const options = state.plan?.options ?? [];
  const option = options[Math.min(pick, options.length - 1)];
  return (
    <section className={cx(styles.card, 'rl-pop')} data-state="open" aria-live="polite" aria-label={intl.formatMessage({ id: 'home.agent.label' })} data-testid="home-agent">
      <p className={styles.brief}>{state.brief}</p>
      {state.text || state.pending ? (
        <p className={styles.reply} data-testid="home-agent-reply">
          {state.text || <FormattedMessage id="home.agent.thinking" />}
        </p>
      ) : null}
      {state.notice ? (
        <p className={styles.notice} role="status">
          {state.notice}
        </p>
      ) : null}
      {option ? (
        <div className={styles.plan} data-testid="home-plan">
          {options.length > 1 ? (
            <div role="radiogroup" aria-label={intl.formatMessage({ id: 'home.agent.options' })} className={styles.options}>
              {options.map((o, i) => (
                <button key={i} type="button" role="radio" aria-checked={i === pick} className={styles.option} onClick={() => setPick(i)} data-testid={`home-plan-option-${i}`}>
                  <span className={styles.optionTitle}>{o.title}</span>
                  <span className={styles.optionMeta}>
                    <FormattedMessage id="home.agent.optionMeta" values={{ seconds: o.seconds, ratio: o.ratio, n: o.estimate.credits }} />
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <ol className={styles.shots}>
            {option.shots.map((s) => (
              <li key={s.n} className={styles.shot}>
                <span className={styles.shotN}>{s.n}</span>
                <span>
                  <FormattedMessage id="home.agent.shot" values={{ title: s.title, seconds: s.seconds, visual: s.visual }} />
                </span>
              </li>
            ))}
          </ol>
          <div className={styles.actions}>
            <span className={styles.estimate}>
              <FormattedMessage id="home.agent.estimate" values={{ n: option.estimate.credits }} />
            </span>
            <button type="button" className={styles.secondary} onClick={onDismiss}>
              <FormattedMessage id="home.agent.dismiss" />
            </button>
            <button type="button" className={cx(styles.primary, 'rl-press')} disabled={building} aria-busy={building || undefined} onClick={() => onBuild(Math.min(pick, options.length - 1))}>
              <FormattedMessage id="home.agent.build" />
            </button>
          </div>
        </div>
      ) : !state.pending ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onDismiss}>
            <FormattedMessage id="home.agent.dismiss" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
