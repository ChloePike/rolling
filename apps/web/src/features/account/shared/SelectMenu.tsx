import { Popover } from '@rolling/ui';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PathIcon, paths } from './Icon';
import styles from './SelectMenu.module.css';

interface SelectMenuProps<T extends string> {
  /** Accessible name of the setting, e.g. “Language”. */
  label: string;
  value: T;
  /** `hint` shows on the right of the option; `text` names a non-string label for screen readers. */
  options: ReadonlyArray<{ value: T; label: ReactNode; hint?: string; text?: string }>;
  onChange: (value: T) => void;
}

/**
 * Settings dropdown: the 34px trigger from Settings.dc.html opening a listbox
 * in the shared Popover (200ms enter, 140ms exit, opacity only when reduced).
 */
export function SelectMenu<T extends string>({ label, value, options, onChange }: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = options.find((o) => o.value === value);

  function onKeyDown(e: KeyboardEvent, i: number) {
    const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    refs.current[(i + delta + options.length) % options.length]?.focus();
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="listbox"
      label={label}
      align="end"
      offset={6}
      className={styles.menu}
      trigger={(t) => (
        <button {...t} type="button" className={styles.trigger} aria-label={`${label}: ${current?.text ?? (typeof current?.label === 'string' ? current.label : value)}`}>
          {current?.label}
          <PathIcon d={paths.chevronDown} size={13} />
        </button>
      )}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="option"
          aria-selected={o.value === value}
          className={styles.option}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => {
            onChange(o.value);
            setOpen(false);
          }}
        >
          <span className={styles.optionLabel}>{o.label}</span>
          {o.hint && <span className={styles.optionHint}>{o.hint}</span>}
          {o.value === value && <PathIcon d={paths.check} size={14} strokeWidth={2.4} />}
        </button>
      ))}
    </Popover>
  );
}
