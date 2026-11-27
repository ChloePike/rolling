import { cx, Popover, presenceProps, staggerStyle, type PopoverTriggerProps, type PresenceState } from '@rolling/ui';
import { useEffect, type KeyboardEvent, type ReactNode } from 'react';
import { useLayer } from './useLayer';
import styles from './menu.module.css';

/** One row of a canvas menu. `checked` makes it a radio/checkbox row. */
export interface MenuEntry {
  key: string;
  label: ReactNode;
  /** Secondary text on the right (shortcut, value, price). */
  meta?: ReactNode;
  checked?: boolean;
  /** `checkbox` rows toggle; others pick. Default `radio` when `checked` is set. */
  kind?: 'radio' | 'checkbox';
  disabled?: boolean;
  /** Tooltip for disabled rows (why it cannot be used). */
  reason?: string;
  /** One-line tooltip of an enabled row. */
  hint?: string;
  danger?: boolean;
  /** Keep the menu open after picking (checkbox rows). */
  keepOpen?: boolean;
  onSelect: () => void;
}

const ITEM = '[role^="menuitem"]';

/** Arrow keys, Home and End move focus between rows (Tab leaves the menu). */
export function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM));
  if (!items.length) return;
  e.preventDefault();
  e.stopPropagation();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next]!.focus();
}

export function MenuRows({ entries, onClose, title }: { entries: MenuEntry[]; onClose: () => void; title?: ReactNode }) {
  return (
    <div className={styles.rows} onKeyDown={rovingKeys}>
      {title ? <span className={styles.title}>{title}</span> : null}
      {entries.map((it, i) => {
        const role = it.checked === undefined ? 'menuitem' : it.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitemradio';
        return (
          <button
            key={it.key}
            type="button"
            role={role}
            aria-checked={it.checked}
            aria-disabled={it.disabled || undefined}
            title={it.disabled ? it.reason : it.hint}
            className={cx(styles.item, it.danger && styles.danger, 'rl-stagger')}
            style={staggerStyle(i)}
            data-motion=""
            data-key={it.key}
            onClick={() => {
              if (it.disabled) return;
              it.onSelect();
              if (!it.keepOpen) onClose();
            }}
          >
            {it.checked !== undefined ? <span className={cx(styles.check, it.checked && styles.checkOn)} aria-hidden="true" /> : null}
            <span className={styles.label}>{it.label}</span>
            {it.meta !== undefined ? <span className={styles.meta}>{it.meta}</span> : null}
            {it.disabled && it.reason ? <span className={styles.reason}>{it.reason}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface MenuPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  entries?: MenuEntry[];
  title?: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
  /** Custom content instead of (or after) the rows. */
  children?: ReactNode;
  role?: 'menu' | 'dialog';
}

/** A menu anchored to its trigger (shared Popover: 200ms in, 140ms out, Esc and outside click close). */
export function MenuPopover({ open, onOpenChange, label, trigger, entries, title, align = 'start', side = 'bottom', children, role = 'menu' }: MenuPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} label={label} role={role} align={align} side={side} trigger={trigger} className={styles.panel}>
      {entries ? <MenuRows entries={entries} title={title} onClose={() => onOpenChange(false)} /> : null}
      {children}
    </Popover>
  );
}

/** A menu at a point (context menus): Esc and outside click close; focus moves to the first row. */
export function PointMenu({
  state,
  x,
  y,
  label,
  entries,
  onClose,
  testId,
}: {
  state: PresenceState;
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
  onClose: () => void;
  testId?: string;
}) {
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { focus: false });
  useEffect(() => {
    if (state === 'open') ref.current?.querySelector<HTMLElement>(ITEM)?.focus({ preventScroll: true });
  }, [state, ref]);
  return (
    <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className={cx(styles.panel, styles.point, 'rl-pop')}
        style={{ left: x, top: y }}
        {...presenceProps(state)}
        data-testid={testId}
      >
        <MenuRows entries={entries} onClose={onClose} />
      </div>
    </div>
  );
}
