import { useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import { Icon } from './icons';
import type { BinItem } from './mocks';
import { formatClipLength } from '@rolling/core/timeline';

type BinTab = 'project' | 'assets' | 'public';
const TABS: BinTab[] = ['project', 'assets', 'public'];

export interface BinProps {
  items: BinItem[];
  /** Bin item for the selected clip. */
  currentId: string | null;
  onPick: (item: BinItem) => void;
}

export function Bin({ items, currentId, onPick }: BinProps) {
  const intl = useIntl();
  const [tab, setTab] = useState<BinTab>('project');
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % 3] : e.key === 'ArrowLeft' ? TABS[(i + 2) % 3] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <aside aria-label={intl.formatMessage({ id: 'editor.bin.label' })} className={styles.bin}>
      <div role="tablist" aria-label={intl.formatMessage({ id: 'editor.bin.tabs' })} className={styles.binTabs} onKeyDown={onKey}>
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            data-tab={k}
            id={`edbin-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`edbin-panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`${styles.btn} ${styles.binTab}`}
            onClick={() => setTab(k)}
          >
            {intl.formatMessage({ id: `editor.bin.${k}` })}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`edbin-panel-${tab}`} aria-labelledby={`edbin-tab-${tab}`} key={tab} className={`${styles.binPanel} ${styles.panelSwap}`}>
        {tab === 'project' ? (
          <ul className={styles.binList}>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.binItem}`}
                  aria-current={item.id === currentId ? 'true' : undefined}
                  onClick={() => onPick(item)}
                >
                  <span className={styles.binThumb} style={{ background: item.color }}>
                    <Icon name={item.kind === 'video' ? 'video' : item.kind === 'image' ? 'image' : 'audio'} size={14} />
                  </span>
                  <span className={styles.binText}>
                    <span className={styles.binTitle}>{item.title}</span>
                    <span className={styles.binMeta}>
                      {item.notGenerated
                        ? intl.formatMessage({ id: 'editor.bin.notGenerated' })
                        : item.seconds === null
                          ? intl.formatMessage({ id: 'editor.bin.image' })
                          : formatClipLength(item.seconds)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          // TODO(overlays): Assets and Public reuse the @ reference picker lists once exported.
          <p className={styles.binEmpty}>{intl.formatMessage({ id: tab === 'assets' ? 'editor.bin.assetsEmpty' : 'editor.bin.publicEmpty' })}</p>
        )}
      </div>
    </aside>
  );
}
