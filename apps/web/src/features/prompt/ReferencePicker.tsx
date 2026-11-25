import { staggerStyle } from '@rolling/ui';
import { LIBRARY_CATEGORIES } from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import { usePublicCategories, usePublicItems, type PublicItem } from '@/lib/publicLibrary';
import { useReferences } from './api';
import { PromptIcon, type PromptIconName } from './icons';
import styles from './ReferencePicker.module.css';
import type { RefItem, RefTab } from './types';

const TABS: RefTab[] = ['all', 'mine', 'char', 'voice', 'pub'];
const WAVE = [10, 22, 14, 26, 12, 18];
const PUB_TONES = ['var(--c-tone-plum)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-teal)', 'var(--c-tone-slate)', 'var(--c-tone-neutral)', 'var(--c-tone-clay)', 'var(--c-tone-moss)'];
const PUB_ICON: Record<LibraryCategoryKey, PromptIconName> = {
  pose: 'pose',
  pose_depth: 'pose',
  portrait: 'user',
  expression: 'face',
  hairstyle: 'hair',
  outfit: 'wear',
  outfit_anime: 'wear',
  outfit_historical: 'wear',
  scene: 'scene',
  lighting: 'light',
  prop: 'prop',
  furniture: 'prop',
};

/** A public-library item (GraphQL) as a picker card. */
function publicRef(intl: IntlShape, item: PublicItem, index: number): RefItem {
  return {
    id: item.id,
    group: 'pub',
    category: item.category,
    name: item.title,
    meta: intl.formatMessage(
      { id: 'prompt.picker.pub.meta' },
      {
        category: intl.formatMessage({ id: `prompt.picker.category.${item.category}` }),
        angles: item.angles.length,
        license: item.license,
      },
    ),
    source: 'public',
    tone: PUB_TONES[index % PUB_TONES.length]!,
    glyph: { type: 'icon', icon: PUB_ICON[item.category] ?? 'img' },
    thumbUrl: item.thumbUrl ?? undefined,
    license: item.license,
  };
}

export interface ReferencePickerProps {
  /** Text typed after `@` in the prompt. Shown as `@query` and used to filter. */
  query?: string;
  /** Items to choose from. Defaults to `useReferences()` (all sources). */
  items?: RefItem[];
  /** Ids already selected when the picker opens. */
  initialSelected?: string[];
  /** Ids already attached to the prompt; they stay selectable but are not duplicated on add. */
  attachedIds?: string[];
  /** Enter or the Add button: the picked items, in picking order. */
  onAdd: (items: RefItem[]) => void;
  /** Esc or the close button. */
  onClose: () => void;
  /** Upload button. */
  onUpload?: () => void;
  /** Focus the search field on open (when opened from `+`, not while typing `@`). */
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The `@` reference picker (MainAt / CanvasAt): tabs All / My assets /
 * Characters / Voices / Public library, public library categories from
 * PoseWear (D-004), multi-select, a source label on every card, upload and
 * an empty state. It is a panel; the host positions it.
 */
export function ReferencePicker({
  query = '',
  items: itemsProp,
  initialSelected = [],
  onAdd,
  onClose,
  onUpload,
  autoFocus = false,
  className,
  style,
}: ReferencePickerProps) {
  const intl = useIntl();
  const t = (id: string, values?: Record<string, unknown>) => intl.formatMessage({ id }, values as never);
  const { data } = useReferences();
  const all = itemsProp ?? data;
  const [tab, setTab] = useState<RefTab>('all');
  const [cat, setCat] = useState<LibraryCategoryKey | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const q = (query + search).toLowerCase();
  const matches = (r: RefItem) => !q || r.name.toLowerCase().includes(q) || r.meta.toLowerCase().includes(q);

  // Public library tab: categories, counts and items from GraphQL (D-004, lib/publicLibrary).
  const { data: facets } = usePublicCategories();
  const counts = useMemo(() => (facets ? new Map(facets.map((f) => [f.key, f.count])) : null), [facets]);
  const pubCategories = LIBRARY_CATEGORIES.filter((c) => !counts || (counts.get(c.key) ?? 0) > 0).map((c) => c.key);
  const pubTotal = counts ? [...counts.values()].reduce((a, b) => a + b, 0) : null;
  const pub = usePublicItems(cat === 'all' ? null : cat, { q: q.trim(), enabled: tab === 'pub' });
  const pubItems = useMemo(() => (pub.data?.pages.flatMap((p) => p.items) ?? []).map((item, i) => publicRef(intl, item, i)), [pub.data, intl]);
  // Picked public items stay addable after switching category or tab.
  const seen = useRef(new Map<string, RefItem>());
  for (const r of pubItems) seen.current.set(r.id, r);

  const list = useMemo(
    () => (tab === 'pub' ? pubItems : all.filter((r) => (tab === 'all' || r.group === tab) && matches(r))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, tab, q, pubItems],
  );

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const commit = () => {
    if (!selected.length) return;
    const byId = new Map([...seen.current, ...all.map((r) => [r.id, r] as const)]);
    onAdd(selected.map((id) => byId.get(id)).filter((r): r is RefItem => !!r));
    setSelected([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && selected.length && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      commit();
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    setCat('all');
    e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  const heading = q
    ? t('prompt.picker.heading.results', { n: list.length })
    : tab === 'pub'
      ? t('prompt.picker.heading.public')
      : tab === 'all'
        ? t('prompt.picker.heading.recent')
        : t(`prompt.picker.tab.${tab}`);
  const n = selected.length;

  return (
    <div
      role="dialog"
      aria-label={t('prompt.picker.label')}
      className={`${styles.picker} ${className ?? ''}`}
      style={style}
      onKeyDown={onKeyDown}
      data-testid="reference-picker"
    >
      <div className={styles.searchRow}>
        <label className={styles.search}>
          <PromptIcon name="search" size={15} className={styles.searchIcon} />
          <span className={styles.searchAt}>{t('prompt.picker.query', { q: query })}</span>
          <input
            ref={inputRef}
            aria-label={t('prompt.picker.search')}
            placeholder={query ? '' : t('prompt.picker.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.searchInput}
          />
        </label>
        <button type="button" className={styles.close} aria-label={t('prompt.picker.close')} onClick={onClose}>
          <PromptIcon name="close" size={16} />
        </button>
      </div>
      <div role="tablist" aria-label={t('prompt.picker.tabs')} className={styles.tabs}>
        {TABS.map((k, i) => {
          const count = k === 'pub' && pubTotal !== null && !q ? pubTotal : all.filter((r) => (k === 'all' || r.group === k) && matches(r)).length;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              data-tab={k}
              aria-selected={tab === k}
              tabIndex={tab === k ? 0 : -1}
              className={styles.tab}
              onClick={() => {
                setTab(k);
                setCat('all');
              }}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t(`prompt.picker.tab.${k}`)}
              <span className={styles.tabCount}>{intl.formatNumber(count)}</span>
            </button>
          );
        })}
      </div>
      {tab === 'pub' ? (
        <div className={`${styles.cats}`} role="group" aria-label={t('prompt.picker.categories')}>
          {(['all', ...pubCategories] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={cat === k}
              className={styles.cat}
              onClick={() => setCat(k)}
            >
              {t(`prompt.picker.category.${k}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.heading}>{heading}</div>
      <div
        key={`${tab}:${cat}`}
        role="listbox"
        aria-label={t('prompt.picker.list')}
        aria-multiselectable="true"
        className={styles.grid}
      >
        {list.map((r, i) => (
          <RefCard key={r.id} item={r} index={i} on={selected.includes(r.id)} onToggle={() => toggle(r.id)} />
        ))}
        {tab === 'pub' && pub.isError ? (
          <div className={styles.empty} role="alert">
            {t('prompt.picker.pub.error')}{' '}
            <button type="button" className={styles.retry} onClick={() => void pub.refetch()}>
              {t('prompt.picker.pub.retry')}
            </button>
          </div>
        ) : tab === 'pub' && pub.isPending ? (
          <div className={styles.empty} role="status">
            {t('prompt.picker.pub.loading')}
          </div>
        ) : list.length === 0 ? (
          <div className={styles.empty}>
            {q ? t('prompt.picker.empty', { q: query + search }) : t('prompt.picker.emptyCategory')}
          </div>
        ) : null}
        {tab === 'pub' && pub.hasNextPage ? (
          <button type="button" className={styles.more} disabled={pub.isFetchingNextPage} onClick={() => void pub.fetchNextPage()}>
            {t(pub.isFetchingNextPage ? 'prompt.picker.pub.loading' : 'prompt.picker.pub.more')}
          </button>
        ) : null}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.upload} onClick={onUpload}>
          <PromptIcon name="upload" size={14} />
          {t('prompt.picker.upload')}
        </button>
        <span aria-live="polite">{n ? t('prompt.picker.selected', { n }) : t('prompt.picker.note')}</span>
        <span className={styles.flex1} />
        <button type="button" className={styles.add} data-picker-add disabled={n === 0} onClick={commit}>
          {n ? t('prompt.picker.addN', { n }) : t('prompt.picker.add')}
        </button>
      </div>
    </div>
  );
}

function RefCard({ item: r, index, on, onToggle }: { item: RefItem; index: number; on: boolean; onToggle: () => void }) {
  const intl = useIntl();
  const [thumbFailed, setThumbFailed] = useState(false);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className={`${styles.card} rl-stagger`}
      style={staggerStyle(index)}
          data-motion=""
      onClick={onToggle}
    >
      <span className={styles.thumb} style={{ background: r.tone }}>
        {r.glyph.type === 'letter' ? <span className={styles.letter}>{r.glyph.letter}</span> : null}
        {r.glyph.type === 'wave' ? (
          <span className={styles.wave}>
            {WAVE.map((h, i) => (
              <span key={i} style={{ height: h }} />
            ))}
          </span>
        ) : null}
        {r.glyph.type === 'icon' ? <PromptIcon name={r.glyph.icon} size={28} strokeWidth={1.5} /> : null}
        {r.thumbUrl && !thumbFailed ? (
          <img
            className={styles.thumbImg}
            src={r.thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
            data-loaded={thumbLoaded}
            onLoad={() => setThumbLoaded(true)}
            onError={() => setThumbFailed(true)}
          />
        ) : null}
        <span className={styles.src}>{intl.formatMessage({ id: `prompt.source.${r.source}` })}</span>
        <span className={styles.check} aria-hidden="true">
          <PromptIcon name="check" size={12} strokeWidth={3} />
        </span>
      </span>
      <span className={styles.name}>{r.name}</span>
      <span className={styles.meta}>{r.meta}</span>
    </button>
  );
}
