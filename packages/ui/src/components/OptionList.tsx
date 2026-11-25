import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx';
import { staggerStyle } from '../motion';
import styles from './OptionList.module.css';
import { nextRovingIndex } from './rovingFocus';

export interface OptionListItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Secondary text on the right, e.g. "Not translated yet". */
  hint?: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  /** `lang` of the label (endonyms in a language list). */
  lang?: string;
}

export interface OptionListProps<V extends string = string> {
  /** Accessible name of the list. */
  label: string;
  options: ReadonlyArray<OptionListItem<V>>;
  value: V;
  /** Click, Enter or Space on an option. */
  onSelect: (value: V) => void;
  /** Escape inside the list (e.g. back to the parent menu). Stops the event from closing the host popover. */
  onEscape?: () => void;
  /** Focus the selected option on mount. Default true. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * A single-choice menu (submenus of settings popovers, pickers): one
 * `menuitemradio` per option with a check on the selected one. ↑↓ Home End
 * move focus, Enter / Space pick, Escape calls `onEscape`. Rows enter with
 * the list stagger (30ms apart, max 6).
 */
export function OptionList<V extends string = string>({ label, options, value, onSelect, onEscape, autoFocus = true, className }: OptionListProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!autoFocus) return;
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    refs.current[i]?.focus({ preventScroll: false });
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      onEscape();
      return;
    }
    const next = nextRovingIndex(e, i, options.length, (j) => !!options[j]?.disabled);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <div role="menu" aria-label={label} className={cx(styles.list, className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            aria-disabled={o.disabled || undefined}
            tabIndex={on ? 0 : -1}
            className={cx('rl-stagger', styles.option)}
            style={staggerStyle(i)}
            data-value={o.value}
            onClick={() => !o.disabled && onSelect(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={styles.label} lang={o.lang}>
              {o.label}
            </span>
            {o.hint ? <span className={styles.hint}>{o.hint}</span> : null}
            <span className={styles.check} aria-hidden="true">
              {on ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
