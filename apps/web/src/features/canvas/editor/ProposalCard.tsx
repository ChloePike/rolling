import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import type { EditProposal } from './mocks';
import { usePresence } from './presence';

/** Exit is the fast duration with the exit curve (Motion.dc.html, popover). */
const EXIT_MS = 140;

export interface ProposalCardProps {
  proposal: EditProposal | null;
  onApply: () => void;
  onDiscard: () => void;
  /** Move focus to Apply when the card opens (when the user just sent the request). */
  focusOnOpen: boolean;
}

/** The agent's proposed timeline edit; nothing changes until Apply (handoff section 4, Editor). */
export function ProposalCard({ proposal, onApply, onDiscard, focusOnOpen }: ProposalCardProps) {
  const intl = useIntl();
  const { mounted, shown } = usePresence(!!proposal, EXIT_MS);
  const last = useRef(proposal);
  if (proposal) last.current = proposal;
  const p = proposal ?? last.current;
  const applyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (proposal && mounted && focusOnOpen) applyRef.current?.focus({ preventScroll: true });
  }, [proposal, mounted, focusOnOpen]);

  if (!mounted || !p) return null;
  return (
    <div
      role="dialog"
      aria-label={intl.formatMessage({ id: 'editor.proposal.label' })}
      className={styles.proposal}
      data-shown={shown}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDiscard();
        }
      }}
    >
      <span className={styles.propAsked}>{intl.formatMessage({ id: 'editor.proposal.asked' }, { request: p.request })}</span>
      <span className={styles.propTitle}>{p.title}</span>
      <ul className={styles.propList}>
        {p.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <span className={styles.propNote}>{p.note}</span>
      <div className={styles.propActions}>
        <button ref={applyRef} type="button" className={`${styles.btn} ${styles.primary} ${styles.apply}`} onClick={onApply} disabled={!proposal}>
          {intl.formatMessage({ id: 'editor.proposal.apply' })}
        </button>
        <button type="button" className={`${styles.btn} ${styles.discard}`} onClick={onDiscard} disabled={!proposal}>
          {intl.formatMessage({ id: 'editor.proposal.discard' })}
        </button>
      </div>
    </div>
  );
}
