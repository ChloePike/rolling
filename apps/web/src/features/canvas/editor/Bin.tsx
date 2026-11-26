import { useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import { Icon } from './icons';
import type { BinItem } from './mocks';
import { formatClipLength } from '@rolling/core/timeline';
import { useReferences, type RefItem } from '@/features/prompt';
import { usePublicItems } from '@/lib/publicLibrary';
import { useAssetPicker } from '@/features/picker';

type BinTab = 'project' | 'assets' | 'public';
const TABS: BinTab[] = ['project', 'assets', 'public'];

/** An asset or public item to put on the timeline. */
export interface BinInsert {
  name: string;
  assetId: string;
  kind: 'image' | 'video' | 'audio';
  /** Length on the timeline; stills default to 3s. */
  seconds?: number;
}

export interface BinProps {
  items: BinItem[];
  /** Bin item for the selected clip. */
  currentId: string | null;
  onPick: (item: BinItem) => void;
  /** Assets / Public: adds the item at the end of its track. */
  onInsert: (item: BinInsert) => void;
}

/** Kind of a picker item from its group and meta line (`Video · 0:08`, `Image · 2048×2048`). */
function refKind(r: RefItem): BinInsert['kind'] {
  if (r.group === 'voice') return 'audio';
  return /^video/i.test(r.meta) ? 'video' : 'image';
}

function RefList({ items, onInsert, empty }: { items: Array<{ id: string; name: string; meta: string; tone: string; thumbUrl?: string | null; kind: BinInsert['kind']; assetId: string }>; onInsert: BinProps['onInsert']; empty: string }) {
  const intl = useIntl();
  if (!items.length) return <p className={styles.binEmpty}>{empty}</p>;
  return (
    <ul className={styles.binList}>
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={`${styles.btn} ${styles.binItem}`}
            aria-label={intl.formatMessage({ id: 'editor.bin.insert' }, { name: item.name })}
            title={intl.formatMessage({ id: 'editor.bin.insert' }, { name: item.name })}
            onClick={() => onInsert({ name: item.name, assetId: item.assetId, kind: item.kind })}
          >
            <span className={styles.binThumb} style={{ background: item.tone }}>
              {item.thumbUrl ? <img src={item.thumbUrl} alt="" className={styles.binImg} /> : <Icon name={item.kind === 'audio' ? 'audio' : item.kind} size={14} />}
            </span>
            <span className={styles.binText}>
              <span className={styles.binTitle}>{item.name}</span>
              <span className={styles.binMeta}>{item.meta}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AssetsTab({ onInsert }: { onInsert: BinProps['onInsert'] }) {
  const intl = useIntl();
  const refs = useReferences().data ?? [];
  const items = refs
    .filter((r) => r.group !== 'pub')
    .map((r) => ({ id: r.id, name: r.name, meta: r.meta, tone: r.tone, thumbUrl: r.thumbUrl, kind: refKind(r), assetId: r.id }));
  return <RefList items={items} onInsert={onInsert} empty={intl.formatMessage({ id: 'editor.bin.assetsEmpty' })} />;
}

function PublicTab({ onInsert }: { onInsert: BinProps['onInsert'] }) {
  const intl = useIntl();
  const q = usePublicItems(null);
  const items = (q.data?.pages.flatMap((p) => p.items) ?? []).map((it, i) => ({
    id: it.id,
    name: it.title,
    meta: intl.formatMessage({ id: 'editor.bin.publicMeta' }, { category: it.category }),
    tone: PUB_TONES[i % PUB_TONES.length]!,
    thumbUrl: it.thumbUrl,
    kind: 'image' as const,
    assetId: it.assetId,
  }));
  if (q.isError) {
    return (
      <div className={styles.binEmpty} role="status">
        <p>{intl.formatMessage({ id: 'editor.bin.publicError' })}</p>
        <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.binRetry}`} onClick={() => void q.refetch()}>
          {intl.formatMessage({ id: 'editor.bin.retry' })}
        </button>
      </div>
    );
  }
  if (q.isPending) return <p className={styles.binEmpty} role="status">{intl.formatMessage({ id: 'editor.bin.loading' })}</p>;
  return (
    <>
      <RefList items={items} onInsert={onInsert} empty={intl.formatMessage({ id: 'editor.bin.publicEmpty' })} />
      {q.hasNextPage ? (
        <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.binRetry}`} disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {intl.formatMessage({ id: 'editor.bin.more' })}
        </button>
      ) : null}
    </>
  );
}

const PUB_TONES = ['var(--c-tone-plum)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-teal)'];

export function Bin({ items, currentId, onPick, onInsert }: BinProps) {
  const intl = useIntl();
  const [tab, setTab] = useState<BinTab>('project');
  /** Import: the shared asset picker modal (My assets, Public library, Recent, Upload into Assets); picks go on the timeline. */
  const picker = useAssetPicker();
  const importAssets = () =>
    void picker.open({ title: intl.formatMessage({ id: 'editor.bin.importTitle' }), multiple: true, confirmLabel: intl.formatMessage({ id: 'editor.bin.importUse' }) }).then((picks) => {
      for (const p of picks ?? []) onInsert({ name: p.name, assetId: p.assetId, kind: p.kind === 'character' ? 'image' : p.kind, ...(p.durationSec ? { seconds: p.durationSec } : {}) });
    });
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
      {picker.element}
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
      <button type="button" className={`${styles.btn} ${styles.binImport}`} aria-haspopup="dialog" onClick={importAssets} data-bin-import="">
        {intl.formatMessage({ id: 'editor.bin.import' })}
      </button>
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
        ) : tab === 'assets' ? (
          <AssetsTab onInsert={onInsert} />
        ) : (
          <PublicTab onInsert={onInsert} />
        )}
      </div>
    </aside>
  );
}
