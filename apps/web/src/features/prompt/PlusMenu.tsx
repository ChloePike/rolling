import { staggerStyle } from '@rolling/ui';
import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { PromptIcon, type PromptIconName } from './icons';
import styles from './PromptBox.module.css';
import type { PromptCommand } from './types';

export type PlusAction = 'upload' | 'assets' | 'reference';

export interface PlusMenuProps {
  /** Skills listed under “Skills · or just type /”. */
  skills: PromptCommand[];
  /** Highlights the active skill row. */
  activeSkillId?: string | null;
  onAction: (action: PlusAction) => void;
  onSkill: (skill: PromptCommand) => void;
  /** Esc: the host closes the menu and returns focus to the `+` button. */
  onClose: () => void;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

const ADD_ITEMS: Array<{ action: PlusAction; icon: PromptIconName; key: string; shortcut?: string }> = [
  { action: 'upload', icon: 'upload', key: 'prompt.plus.upload' },
  { action: 'assets', icon: 'lib', key: 'prompt.plus.assets' },
  { action: 'reference', icon: 'at', key: 'prompt.plus.reference', shortcut: '@' },
];

/** The `+` menu (MainPlus): Add (upload, assets, `@` reference) and Skills. ↑↓ move, Esc closes. */
export function PlusMenu({ skills, activeSkillId, onAction, onSkill, onClose, id, className, style }: PlusMenuProps) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]!.focus();
  };

  let row = 0;
  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      tabIndex={-1}
      aria-label={intl.formatMessage({ id: 'prompt.plus.label' })}
      className={`${styles.plusMenu} ${className ?? ''}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className={styles.menuTitle} aria-hidden="true">
        {intl.formatMessage({ id: 'prompt.plus.add' })}
      </div>
      {ADD_ITEMS.map((a) => (
        <button
          key={a.action}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`${styles.addItem} rl-stagger`}
          style={staggerStyle(row++)}
          data-motion=""
          onClick={() => onAction(a.action)}
          aria-keyshortcuts={a.shortcut}
        >
          <span className={styles.addIcon}>
            <PromptIcon name={a.icon} size={15} />
          </span>
          {intl.formatMessage({ id: a.key })}
          <span className={styles.flex1} />
          <span className={styles.addKey}>{a.shortcut ?? ''}</span>
        </button>
      ))}
      <div className={styles.menuDivider} role="separator" />
      <div className={styles.menuTitle} aria-hidden="true">
        {intl.formatMessage({ id: 'prompt.plus.skills' })}
      </div>
      {skills.map((k) => (
        <button
          key={k.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`${styles.skillItem} rl-stagger`}
          style={staggerStyle(row++)}
          data-motion=""
          data-active={k.id === activeSkillId || undefined}
          onClick={() => onSkill(k)}
        >
          <span className={styles.skillIcon}>
            <PromptIcon name={k.icon} size={15} />
          </span>
          <span className={styles.skillText}>
            <span className={styles.skillName}>/{k.name}</span>
            <span className={styles.skillDesc}>{k.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
