import { staggerStyle } from '@rolling/ui';
import { useIntl } from 'react-intl';
import { PromptIcon } from './icons';
import motion from './motion.module.css';
import styles from './PromptBox.module.css';
import type { PromptCommand, RefItem } from './types';

export interface RefChipsProps {
  refs: RefItem[];
  onRemove: (id: string) => void;
}

/**
 * Selected references shown above the prompt: `@name` plus its source label
 * (Mine, Team, Built-in, Public). Chips wrap.
 */
export function RefChips({ refs, onRemove }: RefChipsProps) {
  const intl = useIntl();
  if (!refs.length) return null;
  return (
    <div className={styles.refRow} data-testid="ref-chips">
      {refs.map((r, i) => (
        <span key={r.id} className={`${styles.refChip} ${motion.chipIn}`} style={staggerStyle(i)}
          data-motion="">
          <span className={styles.refChipThumb} style={{ background: r.tone }}>
            {r.glyph.type === 'letter' ? r.glyph.letter : ''}
          </span>
          {intl.formatMessage({ id: 'prompt.ref.chip' }, { name: r.name })}
          <span className={styles.refChipSrc}>{intl.formatMessage({ id: `prompt.source.${r.source}` })}</span>
          <button
            type="button"
            className={styles.refChipRemove}
            aria-label={intl.formatMessage({ id: 'prompt.ref.remove' })}
            onClick={() => onRemove(r.id)}
          >
            <PromptIcon name="close" size={12} strokeWidth={2.4} />
          </button>
        </span>
      ))}
    </div>
  );
}

export interface SkillChipProps {
  skill: PromptCommand;
  onRemove: () => void;
}

/** The active skill (`/TV ad`) shown above the prompt, in the accent tint. */
export function SkillChip({ skill, onRemove }: SkillChipProps) {
  const intl = useIntl();
  return (
    <div className={styles.skillRow}>
      <span className={`${styles.skillChip} ${motion.chipIn}`} data-testid="skill-chip" data-motion="">
        <PromptIcon name={skill.icon} size={14} />/{skill.name}
        <button
          type="button"
          className={styles.skillRemove}
          aria-label={intl.formatMessage({ id: 'prompt.skill.remove' })}
          onClick={onRemove}
        >
          <PromptIcon name="close" size={16} />
        </button>
      </span>
    </div>
  );
}
