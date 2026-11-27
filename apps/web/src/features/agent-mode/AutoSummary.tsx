import { cx } from '@rolling/ui';
import { FormattedMessage, useIntl } from 'react-intl';
import type { AutoRun, AutoTurn } from '@/features/overlays/agent';
import styles from './agentMode.module.css';

export interface AutoSummaryProps {
  turn: AutoTurn;
  /** Undo one change / every change of the turn (D-021). */
  onUndo: (changeId: string) => void;
  onUndoAll: (turnId: string) => void;
  /** A run over the turn's budget: the user approves it ("Run · N credits") through the normal run flow. */
  onApproveRun: (run: AutoRun) => void;
  /** Change ids whose undo is in flight, or refused (the canvas changed there since). */
  busy?: ReadonlySet<string>;
  failed?: ReadonlySet<string>;
  /** Runs the user already approved here. */
  approved?: ReadonlySet<string>;
}

const REFUSALS = new Set(['INSUFFICIENT_CREDITS', 'MEMBER_LIMIT_REACHED', 'NO_PLAN', 'blocked', 'CONCURRENCY_LIMIT', 'MATURE_REQUIRED', 'SAFETY_BLOCKED']);

/**
 * What an Auto turn did (D-021): "Agent changed …" with Undo per change and Undo all,
 * the spend against the turn's budget, and runs that wait for approval.
 */
export function AutoSummary({ turn, onUndo, onUndoAll, onApproveRun, busy, failed, approved }: AutoSummaryProps) {
  const intl = useIntl();
  const live = turn.changes.filter((c) => c.status === 'applied');
  if (!turn.changes.length && !turn.runs.length) return null;
  return (
    <div className={styles.summary} data-testid="auto-summary" data-turn={turn.turnId}>
      <div className={styles.head}>
        <span>
          {turn.changes.length ? <FormattedMessage id="agent.auto.changed" values={{ count: turn.changes.length }} /> : <FormattedMessage id="agent.auto.runs" values={{ count: turn.runs.length }} />}
        </span>
        <span className={styles.spend} data-testid="auto-spend">
          <FormattedMessage id="agent.auto.spend" values={{ spent: turn.spent, budget: turn.budget }} />
        </span>
      </div>
      {turn.changes.map((c) => (
        <div key={c.id} className={styles.row} data-testid="auto-change" data-status={c.status}>
          <span className={cx(styles.rowText, c.status === 'undone' && styles.rowUndone)}>{c.summary}</span>
          {c.status === 'undone' ? (
            <span className={styles.status} role="status">
              <FormattedMessage id="agent.auto.undone" />
            </span>
          ) : failed?.has(c.id) ? (
            <span className={styles.status} role="status">
              <FormattedMessage id="agent.auto.undoFailed" />
            </span>
          ) : (
            <button type="button" className={styles.small} disabled={busy?.has(c.id)} onClick={() => onUndo(c.id)} aria-label={intl.formatMessage({ id: 'agent.auto.undoLabel' }, { summary: c.summary })}>
              <FormattedMessage id="agent.auto.undo" />
            </button>
          )}
        </div>
      ))}
      {turn.runs.map((r) => (
        <div key={r.id} className={styles.row} data-testid="auto-run" data-status={r.status}>
          <span className={styles.rowText}>
            {r.status === 'started' ? (
              <FormattedMessage id="agent.auto.run.started" values={{ n: r.credits, count: r.nodeIds.length }} />
            ) : r.status === 'needs_approval' ? (
              <FormattedMessage id="agent.auto.run.waiting" values={{ count: r.nodeIds.length }} />
            ) : (
              <FormattedMessage id={`agent.auto.run.refused.${r.code && REFUSALS.has(r.code) ? r.code : 'other'}`} />
            )}
          </span>
          {r.status === 'needs_approval' ? (
            approved?.has(r.id) ? (
              <span className={styles.status} role="status">
                <FormattedMessage id="agent.auto.run.approved" />
              </span>
            ) : (
              <button type="button" className={cx(styles.small, styles.primary, 'rl-press')} title={intl.formatMessage({ id: 'agent.auto.run.approveHint' })} onClick={() => onApproveRun(r)} data-testid="auto-run-approve">
                <FormattedMessage id="agent.auto.run.approve" values={{ n: r.credits }} />
              </button>
            )
          ) : null}
        </div>
      ))}
      {live.length > 1 ? (
        <div className={styles.actions}>
          <button type="button" className={styles.small} onClick={() => onUndoAll(turn.turnId)} data-testid="auto-undo-all">
            <FormattedMessage id="agent.auto.undoAll" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
