import { staggerStyle } from '@rolling/ui';
import { useEffect, useRef, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { PromptIcon } from './icons';
import styles from './PromptBox.module.css';
import type { PromptCommand, PromptCommandGroup } from './types';

export interface CommandPaletteProps {
  /** Already filtered groups (see `filterCommands`). Empty means the empty state. */
  groups: PromptCommandGroup[];
  /** Index into the flattened item list that is highlighted. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onRun: (command: PromptCommand) => void;
  /** DOM id, for `aria-controls` / `aria-activedescendant` on the textarea. */
  id?: string;
  className?: string;
  style?: CSSProperties;
}

/** Row id inside the palette, for `aria-activedescendant`. */
export const paletteOptionId = (paletteId: string, index: number) => `${paletteId}-opt-${index}`;

/**
 * The `/` command palette (Main.dc.html, MainSlash). Grouped rows, the
 * highlighted row follows ↑↓ from the prompt, Enter runs, Esc clears.
 * Keyboard handling lives in the host (the prompt textarea keeps focus).
 */
export function CommandPalette({ groups, activeIndex, onActiveIndexChange, onRun, id, className, style }: CommandPaletteProps) {
  const intl = useIntl();
  const listRef = useRef<HTMLDivElement>(null);
  let flat = 0;
  const empty = groups.length === 0;

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={intl.formatMessage({ id: 'prompt.palette.label' })}
      className={`${styles.palette} ${className ?? ''}`}
      style={style}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the prompt */}
    >
      {groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.title} className={styles.paletteGroup}>
          <div className={styles.paletteTitle} aria-hidden="true">
            {g.title}
          </div>
          {g.items.map((c) => {
            const index = flat++;
            const on = index === activeIndex;
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                tabIndex={-1}
                id={id ? paletteOptionId(id, index) : undefined}
                aria-selected={on}
                className={`${styles.paletteRow} rl-stagger`}
                style={staggerStyle(index)}
          data-motion=""
                data-skill={c.kind === 'skill' || undefined}
                onMouseMove={() => !on && onActiveIndexChange(index)}
                onClick={() => onRun(c)}
              >
                <span className={styles.paletteIcon}>
                  <PromptIcon name={c.icon} size={15} />
                </span>
                <span className={styles.paletteName}>/{c.name}</span>
                <span className={styles.paletteDesc}>{c.description}</span>
              </button>
            );
          })}
        </div>
      ))}
      {empty ? (
        <div className={styles.paletteEmpty}>
          <FormattedMessage id="prompt.palette.empty" />
        </div>
      ) : null}
      <div className={styles.paletteHints} aria-hidden="true">
        <span>
          <FormattedMessage id="prompt.palette.hint.choose" values={{ b: (c) => <b>{c}</b> }} />
        </span>
        <span>
          <FormattedMessage id="prompt.palette.hint.run" values={{ b: (c) => <b>{c}</b> }} />
        </span>
        <span>
          <FormattedMessage id="prompt.palette.hint.close" values={{ b: (c) => <b>{c}</b> }} />
        </span>
        <span className={styles.flex1} />
        <span>
          <FormattedMessage id="prompt.palette.hint.own" />
        </span>
      </div>
    </div>
  );
}
