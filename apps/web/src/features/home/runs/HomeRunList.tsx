import { FormattedMessage, useIntl } from 'react-intl';
import { isActive, type HomeRunCard } from './model';
import { RunCard, type RunCardActions } from './RunCard';
import styles from './RunCard.module.css';

/** The run cards under the Home prompt box, newest first. Nothing renders until there is a run. */
export function HomeRunList({ cards, actions, onClearFinished }: { cards: HomeRunCard[]; actions: RunCardActions; onClearFinished: () => void }) {
  const intl = useIntl();
  if (!cards.length) return null;
  const finished = cards.filter((c) => !isActive(c)).length;
  return (
    <section className={styles.list} aria-labelledby="h-runs" data-testid="home-runs">
      <div className={styles.listHead}>
        <h2 id="h-runs" className={styles.listTitle}>
          <FormattedMessage id="home.runs.title" />
        </h2>
        {finished > 1 ? (
          <button type="button" className={styles.clear} onClick={onClearFinished} aria-label={intl.formatMessage({ id: 'home.runs.clearLabel' }, { n: finished })}>
            <FormattedMessage id="home.runs.clear" />
          </button>
        ) : null}
      </div>
      {cards.map((c, i) => (
        <RunCard key={c.key} card={c} actions={actions} index={i} />
      ))}
    </section>
  );
}
