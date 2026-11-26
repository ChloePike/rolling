import { Popover, Skeleton, type PopoverTriggerProps } from '@rolling/ui';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { usePublicItems, type PublicItem } from '@/lib/publicLibrary';
import { usePref } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import controls from './controls.module.css';
import { ToolIcon, type ToolIconName } from './icons';
import styles from './LibraryPicker.module.css';

/** A public-library item picked as a preset; it goes into the run as a reference (`inputs.referenceAssetIds`). */
export interface LibraryPick {
  id: string;
  assetId: string;
  title: string;
  category: LibraryCategoryKey;
  thumbUrl: string | null;
  /** The item's prompt text (outfits, hairstyles, expressions), added to the run's prompt. */
  promptEn: string | null;
}

export function toPick(item: PublicItem): LibraryPick {
  return { id: item.id, assetId: item.assetId, title: item.title, category: item.category, thumbUrl: item.thumbUrl, promptEn: item.promptEn };
}

const SKELETONS = 9;

interface PanelProps {
  /** Accessible name, e.g. "Action". */
  label: string;
  /** Categories offered as tabs (D-004 keys), first is selected. */
  categories: LibraryCategoryKey[];
  selectedId: string | null;
  onPick: (item: LibraryPick) => void;
  onClear?: () => void;
  /** Optional last row, e.g. "Upload your own…". */
  extra?: { label: string; onSelect: () => void };
}

/**
 * Public library browser (D-004) for a preset row: search, category tabs, a
 * thumbnail grid that loads more as it scrolls (24 per page), skeletons while
 * loading, empty and error states. Items come from `publicItems` (GraphQL,
 * lib/publicLibrary). Mature items are excluded by the server for public
 * surfaces and never shown here unless the viewer may see mature content (D-005).
 */
export function LibraryPanel({ label, categories, selectedId, onPick, onClear, extra }: PanelProps) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const [cat, setCat] = useState<LibraryCategoryKey>(categories[0]!);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const h = window.setTimeout(() => setQ(query.trim()), 250);
    return () => window.clearTimeout(h);
  }, [query]);
  const { matureAllowed } = useSession();
  const maturePref = usePref('matureContent');
  const showMature = matureAllowed && maturePref;
  const res = usePublicItems(cat, { q });
  const items = (res.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => !i.mature || showMature);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = res;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && !isFetchingNextPage && void fetchNextPage(), { root: scroller.current, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  let body: ReactNode;
  if (res.isPending) {
    body = (
      <div className={styles.grid} aria-busy="true">
        {Array.from({ length: SKELETONS }, (_, i) => (
          <Skeleton key={i} className={styles.skeleton} radius={10} delayMs={i * 30} />
        ))}
      </div>
    );
  } else if (res.isError) {
    body = (
      <div className={styles.state} role="alert">
        <span>{t('tools.library.error')}</span>
        <button type="button" className={styles.retry} onClick={() => void res.refetch()}>
          {t('tools.library.retry')}
        </button>
      </div>
    );
  } else if (!items.length) {
    body = <div className={styles.state}>{t(q ? 'tools.library.noMatch' : 'tools.library.empty')}</div>;
  } else {
    body = (
      <div className={styles.grid} role="listbox" aria-label={t(`library.category.${cat}`)}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === selectedId}
            className={styles.item}
            title={item.title}
            data-item={item.id}
            onClick={() => onPick(toPick(item))}
          >
            {item.thumbUrl ? <img className={styles.img} src={item.thumbUrl} alt="" loading="lazy" decoding="async" /> : <ToolIcon name="ref" size={18} color="var(--c-text-4)" />}
            <span className={styles.name}>{item.title}</span>
          </button>
        ))}
        {isFetchingNextPage && Array.from({ length: 3 }, (_, i) => <Skeleton key={`more${i}`} className={styles.skeleton} radius={10} />)}
      </div>
    );
  }

  return (
    <div className={styles.panel} data-library-picker="">
      <div className={styles.head}>
        <span className={styles.title}>{label}</span>
        {onClear && selectedId ? (
          <button type="button" className={styles.clear} onClick={onClear}>
            {t('tools.library.clear')}
          </button>
        ) : null}
      </div>
      <input
        type="search"
        className={styles.search}
        aria-label={t('tools.library.search', { label })}
        placeholder={t('tools.library.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {categories.length > 1 && (
        <div role="tablist" aria-label={t('tools.library.categories')} className={styles.tabs}>
          {categories.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={c === cat} className={styles.tab} onClick={() => setCat(c)}>
              {t(`library.category.${c}`)}
            </button>
          ))}
        </div>
      )}
      <div ref={scroller} className={styles.scroll}>
        {body}
        <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      </div>
      {extra && (
        <button type="button" className={styles.extra} onClick={extra.onSelect}>
          <ToolIcon name="upload" size={14} />
          <span>{extra.label}</span>
        </button>
      )}
    </div>
  );
}

interface RowProps extends Omit<PanelProps, 'onPick' | 'selectedId'> {
  icon: ToolIconName;
  tone: string;
  value: LibraryPick | null;
  /** Text when no library item is set (an uploaded file name, or a mock-mode sample). */
  fallback?: string | null;
  onChange: (item: LibraryPick | null) => void;
  testId: string;
  /** Data attribute name for the row (`data-preset`, `data-look`). */
  attr?: 'preset' | 'look';
}

/** A `›` row of the left panel that opens the library browser; shows the picked item's thumbnail and name, else "Not set". */
export function LibraryRow({ label, categories, icon, tone, value, fallback, onChange, onClear, extra, testId, attr = 'preset' }: RowProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const shown = value?.title ?? fallback ?? intl.formatMessage({ id: 'tools.library.notSet' });
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="dialog"
      label={label}
      align="start"
      offset={6}
      bare
      className={styles.layer}
      trigger={(tp: PopoverTriggerProps) => (
        <button {...tp} type="button" className={controls.pickRow} style={{ flex: 1 }} {...{ [`data-${attr}`]: testId }} data-set={value || fallback ? 'true' : 'false'}>
          <span className={controls.pickThumb} style={{ background: tone, overflow: 'hidden' }}>
            {value?.thumbUrl ? <img className={styles.rowImg} src={value.thumbUrl} alt="" /> : <ToolIcon name={icon} size={18} color="var(--c-text-2)" />}
          </span>
          <span className={controls.pickText}>
            <span className={controls.pickLabel}>{label}</span>
            <span className={controls.pickValue} style={value || fallback ? undefined : { color: 'var(--c-text-3)' }}>
              {shown}
            </span>
          </span>
          <span className={controls.chev}>›</span>
        </button>
      )}
    >
      <LibraryPanel
        label={label}
        categories={categories}
        selectedId={value?.id ?? null}
        onPick={(item) => {
          onChange(item);
          setOpen(false);
        }}
        onClear={
          onClear ?? (value
            ? () => {
                onChange(null);
                setOpen(false);
              }
            : undefined)
        }
        extra={extra ? { label: extra.label, onSelect: () => (setOpen(false), extra.onSelect()) } : undefined}
      />
    </Popover>
  );
}
