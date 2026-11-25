import { useRef, type ReactNode } from 'react';
import { cx } from '../cx';
import { nextRovingIndex } from './rovingFocus';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Reason shown as a native tooltip when disabled. */
  disabledReason?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the radio group. */
  label: string;
  className?: string;
}

/** Single-choice group rendered as a segmented pill row (role="radiogroup"). */
export function SegmentedControl<T extends string>({ options, value, onValueChange, label, className }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.group, className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={o.disabled}
            title={o.disabled ? o.disabledReason : undefined}
            tabIndex={i === selectedIndex ? 0 : -1}
            className={styles.option}
            onClick={() => onValueChange(o.value)}
            onKeyDown={(e) => {
              const next = nextRovingIndex(e, i, options.length, (j) => !!options[j]?.disabled);
              if (next === null) return;
              e.preventDefault();
              const opt = options[next];
              if (!opt) return;
              onValueChange(opt.value);
              refs.current[next]?.focus();
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
