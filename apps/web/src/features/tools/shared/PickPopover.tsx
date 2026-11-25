import { Popover, type PopoverTriggerProps } from '@rolling/ui';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ToolIcon } from './icons';
import styles from './PickPopover.module.css';

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  /** Accessible name of the list, e.g. “Action”. */
  label: string;
  value: string;
  options: PickOption[];
  onChange: (value: string) => void;
  /** Renders the trigger (a `›` row); spread the props onto its button. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Optional last row, e.g. “Upload your own…”. */
  extra?: { label: string; onSelect: () => void };
}

/**
 * Choice list behind a left-panel `›` row (handoff 4): the shared Popover
 * (200ms enter, 140ms exit), ↑↓ to move, Enter/Space to pick, Esc to close.
 */
export function PickPopover({ label, value, options, onChange, trigger, extra }: Props) {
  const [open, setOpen] = useState(false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const count = options.length + (extra ? 1 : 0);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + count) % count]?.focus();
  };
  return (
    <Popover open={open} onOpenChange={setOpen} role="listbox" label={label} align="start" offset={6} className={styles.menu} trigger={trigger}>
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
          <span className={styles.text}>
            <span className={styles.label}>{o.label}</span>
            {o.hint && <span className={styles.hint}>{o.hint}</span>}
          </span>
          {o.value === value && <ToolIcon name="check" size={14} strokeWidth={2.6} />}
        </button>
      ))}
      {extra && (
        <button
          ref={(el) => {
            refs.current[options.length] = el;
          }}
          type="button"
          role="option"
          aria-selected={false}
          className={`${styles.option} ${styles.extra}`}
          onKeyDown={(e) => onKeyDown(e, options.length)}
          onClick={() => {
            setOpen(false);
            extra.onSelect();
          }}
        >
          <ToolIcon name="upload" size={14} />
          <span className={styles.label}>{extra.label}</span>
        </button>
      )}
    </Popover>
  );
}
