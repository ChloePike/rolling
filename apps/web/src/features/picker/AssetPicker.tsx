import { LIBRARY_CATEGORIES } from '@rolling/core/library/categories';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import { cx, Dialog, Skeleton } from '@rolling/ui';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { usePref } from '@/lib/prefs';
import { usePublicCategories, usePublicItems } from '@/lib/publicLibrary';
import { useSession } from '@/lib/session';
import { transfers, useTransfers } from '@/lib/transfers';
import { pickFromPublic, rememberPicks, useMineAssets, useRecentPicks, useUploadToAssets } from './data';
import {
  acceptedFiles,
  acceptFor,
  allowedKinds,
  columnsFor,
  gridMove,
  initialState,
  isSelected,
  mineCells,
  nearEnd,
  pickerReducer,
  publicAllowed,
  visibleRows,
  type GridCell,
} from './state';
import type { AssetPick, AssetPickerOptions, PickerTab, PickerUpload, PickKind } from './types';
import styles from './AssetPicker.module.css';

export interface AssetPickerProps {
  open: boolean;
  options: AssetPickerOptions;
  /** Cancel, Esc, the close button or the backdrop. */
  onClose: () => void;
  /** "Use": the selection, in picking order (always asset ids, never uploads in flight). */
  onConfirm: (picks: AssetPick[]) => void;
}

const MIN_CELL = 140;
const GAP = 10;
/** Name and detail lines under the thumbnail. */
const LABEL_H = 40;
const SKELETON_CELLS = 12;
const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)', 'var(--c-tone-slate)', 'var(--c-tone-moss)'];

/**
 * The one place a user picks media (owner rule: a modal, never a cramped
 * popover). Tabs My assets (the workspace's assets, filtered by kind),
 * Public library (PoseWear categories, D-004, the caller's preselected) and
 * Recent; search, chips, a virtualized grid that loads more as it scrolls,
 * skeletons, empty and error states; single or multi select. Upload (button
 * or drop) goes through the shared transfer queue into the user's Assets
 * (D-011): the new item shows at once with its progress and is selected
 * when it finishes. Keyboard: arrows / Home / End move, Enter or Space
 * picks (Enter in single select also uses it), Esc closes; focus is trapped
 * by the Dialog primitive, which also handles motion and reduced motion.
 */
export function AssetPicker({ open, options, onClose, onConfirm }: AssetPickerProps) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const titleId = useId();
  const kinds = allowedKinds(options);
  const pubOk = publicAllowed(options);
  const [s, dispatch] = useReducer(pickerReducer, options, (o) => initialState(o));
  const [rawQuery, setRawQuery] = useState('');
  useEffect(() => {
    const h = window.setTimeout(() => dispatch({ type: 'query', query: rawQuery.trim() }), 250);
    return () => window.clearTimeout(h);
  }, [rawQuery]);

  const { matureAllowed } = useSession();
  const maturePref = usePref('matureContent');
  const showMature = matureAllowed && maturePref;

  // ---- data per tab
  const withCharacters = kinds.includes('character');
  const mine = useMineAssets(s.kind, s.query, { enabled: open && s.tab === 'mine', withCharacters });
  const pub = usePublicItems(s.category === 'all' ? null : s.category, { q: s.query, enabled: open && s.tab === 'public' && pubOk });
  const facets = usePublicCategories();
  const recent = useRecentPicks();

  const cells: GridCell[] = useMemo(() => {
    if (s.tab === 'mine') {
      const fetched = (mine.data?.pages.flatMap((p) => p.items) ?? []).filter((p) => kinds.includes(p.kind));
      return mineCells(s.uploads, fetched, s.kind, s.query);
    }
    if (s.tab === 'public') {
      const items = (pub.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => !i.mature || showMature).map(pickFromPublic);
      return items.map((pick) => ({ type: 'item', pick }));
    }
    const q = s.query.toLowerCase();
    return recent
      .filter((p) => (kinds.includes(p.kind) || (p.kind === 'image' && kinds.includes('character'))) && (!q || p.name.toLowerCase().includes(q)))
      .map((pick) => ({ type: 'item', pick }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.tab, s.uploads, s.kind, s.query, mine.data, pub.data, recent, showMature, kinds.join()]);

  const query = s.tab === 'mine' ? mine : s.tab === 'public' ? pub : null;
  const pending = !!query && query.isPending && !cells.length;
  const failed = !!query && query.isError && !cells.length;
  const hasNext = !!query?.hasNextPage;
  const fetchingNext = !!query?.isFetchingNextPage;

  // ---- tabs and chips
  const tabs: PickerTab[] = pubOk ? ['mine', 'public', 'recent'] : ['mine', 'recent'];
  const kindChips: Array<PickKind | 'all'> = kinds.length > 1 ? ['all', ...kinds] : [];
  const categoryChips: Array<LibraryCategoryKey | 'all'> = useMemo(() => {
    const counts = facets.data ? new Map(facets.data.map((f) => [f.key, f.count])) : null;
    const has = (k: LibraryCategoryKey) => !counts || (counts.get(k) ?? 0) > 0;
    const preferred = (options.categories ?? []).filter(has);
    const rest = LIBRARY_CATEGORIES.map((c) => c.key).filter((k) => has(k) && !preferred.includes(k));
    return ['all', ...preferred, ...rest];
  }, [facets.data, options.categories]);

  // ---- virtual grid geometry
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // The grid lays out in the content box: clientWidth already excludes the
    // vertical scrollbar, but includes the scroller's horizontal padding.
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      setBox({ width: Math.max(0, Math.floor(el.clientWidth - padX)), height: Math.max(0, el.clientHeight - padY) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, pending, failed]);
  const cols = columnsFor(box.width, MIN_CELL, GAP);
  const cellW = box.width > 0 ? (box.width - GAP * (cols - 1)) / cols : MIN_CELL;
  const rowH = Math.round(cellW + LABEL_H + GAP);
  const rows = Math.ceil(cells.length / cols);
  const range = visibleRows({ scrollTop, height: box.height, rowHeight: rowH, rows, overscan: 2 });
  // Reset scroll when the list changes source.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [s.tab, s.kind, s.category, s.query]);
  // Infinite scroll: the next page loads when the window nears the end.
  useEffect(() => {
    if (!open || !hasNext || fetchingNext || !query) return;
    if (nearEnd(range.end, rows)) void query.fetchNextPage();
  }, [open, hasNext, fetchingNext, range.end, rows, query]);

  // ---- keyboard cursor
  const focusActive = useRef(false);
  const active = Math.min(s.active, Math.max(0, cells.length - 1));
  const moveTo = (i: number) => {
    dispatch({ type: 'active', index: i });
    const el = scroller.current;
    if (el) {
      const top = Math.floor(i / cols) * rowH;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
      setScrollTop(el.scrollTop);
    }
    focusActive.current = true;
  };
  useEffect(() => {
    if (!focusActive.current) return;
    focusActive.current = false;
    scroller.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus({ preventScroll: true });
  });

  // ---- selection
  const confirm = useCallback(
    (picks: AssetPick[]) => {
      if (!picks.length) return;
      rememberPicks(picks);
      onConfirm(picks);
    },
    [onConfirm],
  );
  const pickCell = (cell: GridCell, use: boolean) => {
    if (cell.type !== 'item') return;
    if (use && !s.multiple) return confirm([cell.pick]);
    dispatch({ type: 'toggle', pick: cell.pick });
  };
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) || (e.key === 'Enter' && s.multiple && e.shiftKey)) {
      e.preventDefault();
      return confirm(s.selected);
    }
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      return moveTo(gridMove(active, e.key, cols, cells.length));
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const cell = cells[active];
      if (!cell) return;
      e.preventDefault();
      pickCell(cell, e.key === 'Enter');
    }
  };

  // ---- uploads (shared transfer queue → the user's Assets)
  const upload = useUploadToAssets();
  const fileRef = useRef<HTMLInputElement>(null);
  const [refusedCount, setRefusedCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startUploads = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const { ok, refused } = acceptedFiles(files, kinds);
    const chosen = s.multiple ? ok : ok.slice(0, 1);
    const { items, refused: tooBig } = upload(chosen, { projectId: options.projectId });
    setRefusedCount(refused.length + tooBig.length + (ok.length - chosen.length));
    if (!items.length) return;
    dispatch({
      type: 'uploadStarted',
      uploads: items.map((it): PickerUpload => {
        const k = it.file.type.split('/')[0];
        const kind: PickKind = k === 'video' ? 'video' : k === 'audio' ? 'audio' : 'image';
        return { id: it.id, name: it.file.name, kind, previewUrl: kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(it.file) : null, status: 'uploading' };
      }),
    });
    for (const it of items) {
      it.done.then(
        (pick) => dispatch({ type: 'uploadDone', id: it.id, pick }),
        () => dispatch({ type: 'uploadFailed', id: it.id }),
      );
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    startUploads(e.dataTransfer.files);
  };

  // Search first: the Dialog focuses its first control (Close), then this moves focus to the field.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(h);
  }, [open]);

  const n = s.selected.length;
  const close = useCallback((o: boolean) => !o && onClose(), [onClose]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    dispatch({ type: 'tab', tab: next });
    tabRefs.current[next]?.focus();
  };

  const emptyText = s.query ? t('picker.noMatch') : t(`picker.empty.${s.tab}`);
  const placeholder = t(`picker.searchPlaceholder.${s.tab}`);

  return (
    <Dialog open={open} onOpenChange={close} bare labelledBy={titleId} className={styles.panel}>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {options.title ?? t('picker.title')}
        </h2>
        <button type="button" className={styles.close} aria-label={t('picker.close')} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18 M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className={styles.bar}>
        <div role="tablist" aria-label={t('picker.tabs')} className={styles.tabs}>
          {tabs.map((k, i) => (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              type="button"
              role="tab"
              data-picker-tab={k}
              aria-selected={s.tab === k}
              tabIndex={s.tab === k ? 0 : -1}
              className={styles.tab}
              onClick={() => dispatch({ type: 'tab', tab: k })}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t(`picker.tab.${k}`)}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={styles.searchIcon}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input ref={searchRef} type="search" aria-label={t('picker.search')} placeholder={placeholder} value={rawQuery} onChange={(e) => setRawQuery(e.target.value)} className={styles.searchInput} data-picker-search="" />
        </label>
      </div>

      {s.tab === 'mine' && kindChips.length ? (
        <div role="group" aria-label={t('picker.kinds')} className={styles.chips}>
          {kindChips.map((k) => (
            <button key={k} type="button" aria-pressed={s.kind === k} className={styles.chip} data-picker-kind={k} onClick={() => dispatch({ type: 'kind', kind: k })}>
              {t(`picker.kind.${k}`)}
            </button>
          ))}
        </div>
      ) : null}
      {s.tab === 'public' ? (
        <div role="group" aria-label={t('picker.categories')} className={styles.chips}>
          {categoryChips.map((k) => (
            <button key={k} type="button" aria-pressed={s.category === k} className={styles.chip} data-picker-category={k} onClick={() => dispatch({ type: 'category', category: k })}>
              {k === 'all' ? t('picker.category.all') : t(`library.category.${k}`)}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.body} onDragOver={onDragOver} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop} data-dragging={dragging || undefined}>
        <div ref={scroller} className={styles.scroll} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-picker-scroll="">
          {pending ? (
            <div className={styles.skeletons} aria-busy="true" style={{ '--cols': cols } as CSSProperties}>
              {Array.from({ length: SKELETON_CELLS }, (_, i) => (
                <span key={i} className={styles.skeletonCell}>
                  <Skeleton className={styles.skeletonThumb} radius={10} delayMs={150 + i * 30} />
                  <Skeleton text width="70%" delayMs={150 + i * 30} />
                </span>
              ))}
            </div>
          ) : failed ? (
            <div className={styles.state} role="alert">
              <span>{t('picker.error')}</span>
              <button type="button" className={styles.retry} onClick={() => void query?.refetch()}>
                {t('picker.retry')}
              </button>
            </div>
          ) : !cells.length ? (
            <div className={styles.state} data-picker-empty="">
              {emptyText}
            </div>
          ) : (
            <div
              role="listbox"
              aria-label={t('picker.grid', { tab: s.tab })}
              aria-multiselectable={s.multiple || undefined}
              className={styles.grid}
              style={{ height: rows * rowH - GAP }}
              onKeyDown={onGridKey}
              data-count={cells.length}
            >
              {cells.slice(range.start * cols, range.end * cols).map((cell, k) => {
                const i = range.start * cols + k;
                const style: CSSProperties = { width: cellW, height: rowH - GAP, transform: `translate(${(i % cols) * (cellW + GAP)}px, ${Math.floor(i / cols) * rowH}px)` };
                return cell.type === 'upload' ? (
                  <UploadCell key={cell.upload.id} upload={cell.upload} index={i} active={i === active} style={style} onFocus={() => dispatch({ type: 'active', index: i })} />
                ) : (
                  <ItemCell
                    key={`${cell.pick.id}:${i}`}
                    pick={cell.pick}
                    index={i}
                    count={cells.length}
                    on={isSelected(s.selected, cell.pick)}
                    active={i === active}
                    style={style}
                    showSource={s.tab !== 'public'}
                    showCategory={s.tab !== 'public' || s.category === 'all'}
                    onFocus={() => dispatch({ type: 'active', index: i })}
                    onClick={() => pickCell(cell, false)}
                    onDoubleClick={() => pickCell(cell, true)}
                  />
                );
              })}
            </div>
          )}
          {fetchingNext ? (
            <div className={styles.more} role="status">
              {t('picker.loadingMore')}
            </div>
          ) : null}
        </div>
        {dragging ? (
          <div className={styles.dropLayer} aria-hidden="true">
            {t('picker.drop')}
          </div>
        ) : null}
      </div>

      <div className={styles.footer}>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={acceptFor(kinds)}
          multiple={s.multiple}
          data-testid="picker-upload-input"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            startUploads(files);
          }}
        />
        <button type="button" className={styles.upload} onClick={() => fileRef.current?.click()} data-picker-upload="">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4 M7 9l5-5 5 5 M4 20h16" />
          </svg>
          {t('picker.upload')}
        </button>
        <span className={styles.hint}>{refusedCount ? t('picker.refused', { n: refusedCount }) : t('picker.uploadHint')}</span>
        <span className={styles.flex} />
        <span className={styles.count} aria-live="polite">
          {t('picker.selected', { n })}
        </span>
        <button type="button" className={styles.cancel} onClick={onClose}>
          {t('picker.cancel')}
        </button>
        <button type="button" className={styles.use} disabled={n === 0} onClick={() => confirm(s.selected)} data-picker-use="">
          {options.confirmLabel ?? (s.multiple && n > 1 ? t('picker.useN', { n }) : t('picker.use'))}
        </button>
      </div>
    </Dialog>
  );
}

const SOURCE_KEY: Record<AssetPick['source'], string> = { mine: 'picker.source.mine', team: 'picker.source.team', builtin: 'picker.source.builtin', public: 'picker.source.public', generated: 'picker.source.generated' };

function Glyph({ kind }: { kind: PickKind }) {
  const d =
    kind === 'video'
      ? 'M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M16 10l5-3v10l-5-3'
      : kind === 'audio'
        ? 'M3 10v4 M7 7v10 M11 4v16 M15 8v8 M19 6v12'
        : kind === 'character'
          ? 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0'
          : 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8.5a1.5 1.5 0 1 1 0 .01';
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function ItemCell(p: { pick: AssetPick; index: number; count: number; on: boolean; active: boolean; style: CSSProperties; showSource: boolean; showCategory: boolean; onFocus: () => void; onClick: () => void; onDoubleClick: () => void }) {
  const intl = useIntl();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { pick } = p;
  // Under the name: the item's own detail (size, duration), else its library
  // category when that tells the user something; never the bare kind.
  const meta = pick.meta ?? (p.showCategory && pick.category ? intl.formatMessage({ id: `library.category.${pick.category}` }) : null);
  return (
    <button
      type="button"
      role="option"
      aria-selected={p.on}
      aria-posinset={p.index + 1}
      aria-setsize={p.count}
      tabIndex={p.active ? 0 : -1}
      data-index={p.index}
      data-pick={pick.id}
      data-asset={pick.assetId}
      className={styles.cell}
      style={p.style}
      onFocus={p.onFocus}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      title={pick.name}
    >
      <span className={styles.thumb} style={{ background: TONES[p.index % TONES.length] }}>
        <Glyph kind={pick.kind} />
        {pick.thumbUrl && !failed ? (
          <img
            className={cx(styles.img, pick.mature && styles.blur)}
            src={pick.thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
            data-loaded={loaded}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : null}
        {/* The source badge only helps in mixed lists; inside Public library every tile is public. */}
        {p.showSource ? <span className={styles.src}>{intl.formatMessage({ id: SOURCE_KEY[pick.source] })}</span> : null}
        {pick.mature ? <span className={styles.mature}>{intl.formatMessage({ id: 'picker.mature' })}</span> : null}
        <span className={styles.check} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-10" />
          </svg>
        </span>
      </span>
      <span className={styles.name}>{pick.name}</span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </button>
  );
}

function UploadCell(p: { upload: PickerUpload; index: number; active: boolean; style: CSSProperties; onFocus: () => void }) {
  const intl = useIntl();
  const snap = useTransfers();
  const item = snap.items.find((i) => i.id === p.upload.id);
  const pct = item && item.size ? Math.min(1, item.bytesDone / item.size) : 0;
  const failed = p.upload.status === 'failed' || item?.status === 'failed';
  return (
    <div
      role="option"
      aria-selected={false}
      aria-disabled="true"
      tabIndex={p.active ? 0 : -1}
      data-index={p.index}
      data-upload={p.upload.id}
      data-state={failed ? 'failed' : 'uploading'}
      className={cx(styles.cell, styles.uploadCell)}
      style={p.style}
      onFocus={p.onFocus}
    >
      <span className={styles.thumb} style={{ background: 'var(--c-surface-5)' }}>
        <Glyph kind={p.upload.kind} />
        {p.upload.previewUrl ? <img className={styles.img} src={p.upload.previewUrl} alt="" data-loaded="true" /> : null}
        <span className={styles.progress} role="progressbar" aria-label={p.upload.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
          <span style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
      <span className={styles.name}>{p.upload.name}</span>
      {failed ? (
        <button type="button" className={styles.retryInline} aria-label={intl.formatMessage({ id: 'picker.uploadRetry' }, { name: p.upload.name })} onClick={() => transfers.retry(p.upload.id)}>
          {intl.formatMessage({ id: 'picker.uploadFailed' })}
        </button>
      ) : (
        <span className={styles.meta}>{intl.formatMessage({ id: 'picker.uploading' }, { pct })}</span>
      )}
    </div>
  );
}
