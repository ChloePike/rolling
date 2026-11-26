import { Skeleton } from '@rolling/ui';
import type { ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { PromptIcon } from './icons';
import styles from './PromptBox.module.css';

export interface CostLineProps {
  /** Quoted credits for the run. Omit when `label` says it is free; `null` = no quote yet (a small skeleton, never a guessed number). */
  credits?: number | null;
  /** Replaces the number, e.g. “Planning is free”. */
  label?: ReactNode;
  /**
   * `home`: coin icon and muted text (Main.dc.html).
   * `dock`: bold number then “credits” (QuickCreate.dc.html composer).
   */
  variant?: 'home' | 'dock';
}

/** The quote shown next to the send button. Every prompt box shows its cost before running (handoff 4). */
export function CostLine({ credits, label, variant = 'home' }: CostLineProps) {
  if (label === undefined && (credits === null || credits === undefined)) {
    return (
      <span className={variant === 'dock' ? styles.costDock : styles.cost} data-testid="prompt-cost" aria-busy="true">
        <Skeleton width={variant === 'dock' ? 72 : 64} height={13} />
      </span>
    );
  }
  if (variant === 'dock') {
    return (
      <span className={styles.costDock} data-testid="prompt-cost">
        {label ?? (
          <FormattedMessage
            id="prompt.cost.creditsRich"
            values={{ n: credits!, b: (c: ReactNode[]) => <b>{c}</b> }}
          />
        )}
      </span>
    );
  }
  return (
    <span className={styles.cost} data-testid="prompt-cost">
      <PromptIcon name="coin" size={13} />
      {label ?? <FormattedMessage id="prompt.cost.credits" values={{ n: credits! }} />}
    </span>
  );
}
