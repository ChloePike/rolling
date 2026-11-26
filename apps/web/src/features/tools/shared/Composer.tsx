import { Skeleton } from '@rolling/ui';
import { useId, useState, type RefObject } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { ComposerPill, ComposerRef } from '../types';
import styles from './Composer.module.css';
import { ToolIcon } from './icons';

export interface ComposerProps {
  noteLead: string;
  noteChips: string[];
  refs: ComposerRef[];
  label: string;
  text: string;
  onText: (text: string) => void;
  placeholder: string;
  pills: ComposerPill[];
  /** Which pill popover is open: the model pill's picker or the shared settings popover. */
  openOverlay: 'model' | 'params' | null;
  onPill: (pill: ComposerPill, index: number) => void;
  /** Quoted credits (`POST /api/runs/quote`); null: no quote (an input is missing or the server refused). */
  cost: number | null;
  /** A quote is on its way: a skeleton instead of a number. */
  costLoading?: boolean;
  goLabel: string;
  onSend: () => void;
  /** Refine goes through the agent (members only, D-007). */
  onRefine?: () => void;
  /** `+`: add a reference from a file (the `@` picker covers library assets). */
  onAdd?: () => void;
  /** Refine is running (the agent rewrites the prompt). */
  refining?: boolean;
  /** The pill row; anchored popovers ignore pointer down here so pills can toggle them. */
  pillsRef?: RefObject<HTMLDivElement | null>;
}

/**
 * Tool composer (prompt box variant with a note line and reference chips).
 * TODO(prompt): replace with `PromptBox` from `features/prompt` once it supports
 * the tool variant (note line, numbered refs, cost + send cluster).
 */
export function Composer(p: ComposerProps) {
  // All parameter pills share one settings popover; only the pill that opened it shows as open.
  const [openedPill, setOpenedPill] = useState<string | null>(null);
  const intl = useIntl();
  const id = useId();
  return (
    <div className={styles.dock}>
      <div className={styles.box} data-testid="tool-composer">
        {p.noteChips.length > 0 && (
          <div className={styles.note}>
            <span>{p.noteLead}</span>
            {p.noteChips.map((c) => (
              <span key={c} className={styles.noteChip}>
                {c}
              </span>
            ))}
          </div>
        )}
        <div className={styles.input}>
          {p.refs.map((r) => (
            <div key={r.badge} className={styles.ref} style={{ background: r.tone }} data-ref={r.badge}>
              <span className={styles.refBadge}>{r.badge}</span>
            </div>
          ))}
          <label htmlFor={id} className="rl-visually-hidden">
            {p.label}
          </label>
          <textarea
            id={id}
            rows={2}
            className={styles.textarea}
            value={p.text}
            placeholder={p.placeholder}
            onChange={(e) => p.onText(e.target.value)}
          />
        </div>
        <div className={styles.bar}>
          <div className={styles.left} ref={p.pillsRef}>
            <button type="button" className={styles.add} aria-label={intl.formatMessage({ id: 'tools.composer.add' })} onClick={p.onAdd}>
              <ToolIcon name="plus" size={15} strokeWidth={2.2} />
            </button>
            {p.pills.map((pill, i) => (
              <button
                key={pill.id}
                type="button"
                className={i === 0 ? `${styles.pill} ${styles.pillModel}` : styles.pill}
                aria-expanded={i === 0 ? p.openOverlay === 'model' : p.openOverlay === 'params' && openedPill === pill.id}
                aria-haspopup="dialog"
                data-pill={pill.id}
                onClick={() => {
                  setOpenedPill(pill.id);
                  p.onPill(pill, i);
                }}
              >
                <ToolIcon name={pill.icon} size={14} />
                {pill.label}
                {i === 0 && <ToolIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />}
              </button>
            ))}
          </div>
          <div className={styles.right}>
            <button
              type="button"
              className={styles.refine}
              aria-label={intl.formatMessage({ id: 'tools.composer.refine.label' })}
              title={intl.formatMessage({ id: 'tools.composer.refine.label' })}
              onClick={p.onRefine}
              disabled={p.refining}
              aria-busy={p.refining || undefined}
            >
              <FormattedMessage id={p.refining ? 'tools.composer.refining' : 'tools.composer.refine'} />
            </button>
            <span className={styles.cost} data-cost={p.cost ?? undefined} aria-busy={p.costLoading || undefined}>
              {p.costLoading ? (
                <Skeleton width={64} height={13} />
              ) : p.cost !== null ? (
                <FormattedMessage id="tools.composer.cost" values={{ n: p.cost, b: (c) => <b>{c}</b> }} />
              ) : null}
            </span>
            <button type="button" className={styles.send} aria-label={p.goLabel} title={p.goLabel} onClick={p.onSend}>
              <ToolIcon name="send" size={16} strokeWidth={2.8} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
