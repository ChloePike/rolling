import { useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { nextRovingIndex } from './rovingFocus';
import styles from './Tabs.module.css';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Optional count shown after the label. */
  count?: ReactNode;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onValueChange: (value: T) => void;
  label: string;
  /** `square` (8px radius, editor and picker tabs) or `pill` (filters). */
  shape?: 'square' | 'pill';
  /** Base for tab/panel ids; pair with <TabPanel idBase value>. */
  idBase?: string;
  className?: string;
}

export function tabId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}
export function panelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}

/** Tab list with automatic activation and arrow-key navigation. */
export function Tabs<T extends string>({ items, value, onValueChange, label, shape = 'square', idBase, className }: TabsProps<T>) {
  const fallbackId = useId();
  const base = idBase ?? fallbackId;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className={cx(styles.list, shape === 'pill' && styles.pill, className)}>
      {items.map((t, i) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={tabId(base, t.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={idBase ? panelId(base, t.value) : undefined}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onValueChange(t.value)}
            onKeyDown={(e) => {
              const next = nextRovingIndex(e, i, items.length, () => false);
              if (next === null) return;
              e.preventDefault();
              const item = items[next];
              if (!item) return;
              onValueChange(item.value);
              refs.current[next]?.focus();
            }}
          >
            {t.icon ? <span aria-hidden="true">{t.icon}</span> : null}
            {t.label}
            {t.count !== undefined ? <span className={styles.count}>{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  idBase: string;
  value: string;
  children: ReactNode;
}

export function TabPanel({ idBase, value, children, ...rest }: TabPanelProps) {
  return (
    <div role="tabpanel" id={panelId(idBase, value)} aria-labelledby={tabId(idBase, value)} tabIndex={0} {...rest}>
      {children}
    </div>
  );
}
