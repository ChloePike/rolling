import type { ReactNode } from 'react';
import styles from './controls.module.css';

interface ChipGroupProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}

/** Single-select filter chips (toggle buttons with aria-pressed). */
export function ChipGroup<T extends string>({ label, options, value, onChange }: ChipGroupProps<T>) {
  return (
    <div role="group" aria-label={label} className={styles.chips}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.chip}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
