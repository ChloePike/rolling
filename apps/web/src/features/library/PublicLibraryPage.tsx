import { useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ChipGroup, motion, PathIcon, paths, SearchField } from '@/features/account/shared';
import { shortId, usePublicCategories, usePublicItems, usePublicSubCategories, type PublicItem } from '@/lib/publicLibrary';
import { categoryGroups, findCategory, LICENSE_CHIP, type CategoryView } from './catalog';
import styles from './PublicLibrary.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
const TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)', 'var(--c-tone-moss)', 'var(--c-tone-clay)', 'var(--c-tone-slate)'];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * `/assets/public` (PublicLibrary.dc.html). Category registry and licenses from
 * packages/core (D-004); item and sub-category counts, filtering and images
 * from the GraphQL API (lib/publicLibrary).
 */
export function PublicLibraryPage({ category, onCategory }: { category?: string; onCategory?: (key: string) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const { data: categoryFacets } = usePublicCategories();
  const counts = useMemo(() => (categoryFacets ? new Map(categoryFacets.map((f) => [f.key, f.count])) : null), [categoryFacets]);
  const groups = useMemo(() => categoryGroups(counts), [counts]);
  const cat = findCategory(category, groups);
  const { data: subFacets = [] } = usePublicSubCategories(cat.key);
  const [sub, setSub] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = useDebounced(query.trim(), 250);
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = usePublicItems(cat.key, {
    sub: sub === 'all' ? null : sub,
    q,
  });

  useEffect(() => {
    setSub('all');
    setSelectedId(null);
  }, [cat.key]);

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const selectedIndex = Math.max(0, items.findIndex((i) => i.id === selectedId));
  const selected = items[selectedIndex];
  // Search narrows the list below the facet counts; count what is loaded then.
  const total = q ? items.length : sub === 'all' ? (counts?.get(cat.key) ?? items.length) : (subFacets.find((f) => f.key === sub)?.count ?? items.length);

  function surprise() {
    if (!items.length) return;
    setSelectedId(items[Math.floor(Math.random() * items.length)]!.id);
  }

  return (
    <div className={styles.page}>
      <nav aria-label={intl.formatMessage({ id: 'library.public.categories' })} className={styles.cats}>
        <Link to="/assets" className={styles.back}>
          <PathIcon d={paths.chevronLeft} size={15} />
          <FormattedMessage id="library.public.back" />
        </Link>
        {groups.map((g) => (
          <div key={g.group.key} role="group" aria-labelledby={`grp-${g.group.key}`} style={{ display: 'contents' }}>
            <span id={`grp-${g.group.key}`} className={styles.groupLabel}>
              <FormattedMessage id={g.group.messageId} />
            </span>
            {g.categories.map((c) => (
              <Link
                key={c.key}
                to="/assets/public"
                search={{ cat: c.key }}
                className={styles.cat}
                aria-current={c.key === cat.key ? 'page' : undefined}
                onClick={() => onCategory?.(c.key)}
              >
                <PathIcon d={c.glyph} size={16} />
                <span className={styles.catLabel}>
                  <FormattedMessage id={c.def.messageId} />
                </span>
                <span className={styles.catCount}>{counts ? intl.formatNumber(counts.get(c.key) ?? 0) : null}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <section className={styles.main} aria-labelledby="public-title">
        <div className={styles.head}>
          <div className={styles.titles}>
            <h1 id="public-title" className={styles.title}>
              <FormattedMessage id="library.public.title" />
            </h1>
            <span className={styles.sub}>
              <FormattedMessage id="library.public.lead" />
            </span>
          </div>
          <span className={styles.spacer} />
          <SearchField placeholder={intl.formatMessage({ id: 'library.public.search' })} value={query} onChange={setQuery} />
          <button type="button" className={styles.round} aria-label={intl.formatMessage({ id: 'library.public.surprise' })} onClick={surprise}>
            <PathIcon d={paths.shuffle} size={16} />
          </button>
        </div>
        <div className={styles.filters}>
          <ChipGroup
            label={intl.formatMessage({ id: 'library.public.subs' })}
            value={sub}
            onChange={setSub}
            options={[
              { value: 'all', label: intl.formatMessage({ id: 'library.sub.all' }) },
              ...subFacets.map((f) => ({ value: f.key, label: intl.formatMessage({ id: `library.sub.${f.key}`, defaultMessage: f.key }) })),
            ]}
          />
          <span className={styles.spacer} />
          <span className={styles.count} aria-live="polite">
            <FormattedMessage id="library.public.count" values={{ n: total }} />
          </span>
        </div>
        {isError ? (
          <div className={cx(styles.state, motion.enter)} role="alert">
            <FormattedMessage id="library.public.error" />
            <button type="button" className={styles.more} onClick={() => void refetch()}>
              <FormattedMessage id="library.public.retry" />
            </button>
          </div>
        ) : isPending ? (
          <div className={styles.state} role="status">
            <FormattedMessage id="library.public.loading" />
          </div>
        ) : items.length === 0 ? (
          <div className={cx(styles.state, motion.enter)}>
            <FormattedMessage id="library.public.empty" />
          </div>
        ) : (
          <div key={`${cat.key}:${sub}:${q}`} className={styles.grid}>
            {items.map((item, i) => (
              <ItemCard key={item.id} item={item} cat={cat} index={i} on={i === selectedIndex} onPick={() => setSelectedId(item.id)} />
            ))}
          </div>
        )}
        {hasNextPage && !isError && (
          <button type="button" className={styles.more} disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            <FormattedMessage id={isFetchingNextPage ? 'library.public.loading' : 'library.public.more'} />
          </button>
        )}
      </section>

      <Details
        cat={cat}
        item={selected}
        tone={TONES[selectedIndex % TONES.length]!}
        onCopy={async (text) => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            // Clipboard can be blocked; the toast still confirms the action.
          }
          toast.show({ message: intl.formatMessage({ id: 'library.public.copied' }) });
        }}
      />
    </div>
  );
}

function Thumb({ item, cat, tone, big }: { item: PublicItem | undefined; cat: CategoryView; tone: string; big?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <svg
        width={big ? '62%' : '64%'}
        height={big ? '82%' : '78%'}
        viewBox="0 0 24 24"
        fill="none"
        stroke={big ? 'color-mix(in srgb,var(--c-text-1) 28%,transparent)' : 'color-mix(in srgb,var(--c-text-1) 22%,transparent)'}
        strokeWidth={big ? 1.2 : 1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={cat.glyph} />
      </svg>
      {item?.thumbUrl && !failed && (
        <img
          className={styles.thumbImg}
          src={item.thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{ background: tone }}
        />
      )}
    </>
  );
}

function ItemCard({ item, cat, index, on, onPick }: { item: PublicItem; cat: CategoryView; index: number; on: boolean; onPick: () => void }) {
  const intl = useIntl();
  const tone = TONES[index % TONES.length]!;
  const chip = item.license === 'first-party' ? null : LICENSE_CHIP[item.license];
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cx(styles.item, motion.stagger)}
      style={{ '--i': index } as CSSProperties}
      onClick={onPick}
      data-item={item.id}
    >
      <span className={styles.thumb} style={{ aspectRatio: cat.ar, background: tone }}>
        <Thumb item={item} cat={cat} tone={tone} />
        <span className={styles.badge}>{shortId(item.id)}</span>
      </span>
      <span className={styles.name}>{item.title}</span>
      <span className={styles.meta}>
        <span className={styles.metaText}>{item.sub ? intl.formatMessage({ id: `library.sub.${item.sub}`, defaultMessage: item.sub }) : ''}</span>
        {chip && (
          <span className={styles.lic} style={{ background: chip.bg, color: chip.fg }} data-license={item.license}>
            <FormattedMessage id={`library.license.${item.license}`} />
          </span>
        )}
      </span>
    </button>
  );
}

/** Where each “Use as …” action opens (the reference is carried by the tool once the shared reference store lands). */
const USE_ROUTE: Record<string, '/create/quick' | '/create/character' | '/p/$projectId'> = {
  pose: '/create/quick',
  face: '/create/character',
  expression: '/create/character',
  hairstyle: '/create/character',
  dress: '/create/character',
  setting: '/create/quick',
  lighting: '/create/quick',
  canvas: '/p/$projectId',
};

function Details({ cat, item, tone, onCopy }: { cat: CategoryView; item: PublicItem | undefined; tone: string; onCopy: (text: string) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const [fav, setFav] = useState<Record<string, boolean>>({});
  const [board, setBoard] = useState<Record<string, boolean>>({});
  const ctaKey = cat.cta.split('.').pop() ?? 'canvas';
  const use = () => {
    if (!item) return;
    const to = USE_ROUTE[ctaKey] ?? '/create/quick';
    toast.show({ message: intl.formatMessage({ id: 'library.public.used' }, { title: item.title, use: intl.formatMessage({ id: cat.cta }) }) });
    if (to === '/p/$projectId') void navigate({ to, params: { projectId: 'prj_demo' } });
    else void navigate({ to });
  };
  return (
    <aside aria-label={intl.formatMessage({ id: 'library.public.details' })} className={styles.detail}>
      <div key={item?.id ?? 'none'} className={cx(styles.detailInner, motion.enter)}>
        <div className={styles.preview} style={{ aspectRatio: cat.ar, background: tone }}>
          <Thumb item={item} cat={cat} tone={tone} big />
          <span className={styles.view}>
            <FormattedMessage id={cat.def.messageId} />
          </span>
        </div>
        {item && (
          <>
            <div className={styles.info}>
              <span className={styles.infoId}>
                <FormattedMessage id="library.public.itemId" values={{ id: shortId(item.id), category: intl.formatMessage({ id: cat.def.messageId }) }} />
              </span>
              <span className={styles.infoName}>{item.title}</span>
              <div className={styles.tags}>
                {item.tags.slice(0, 3).map((t) => (
                  <span key={t} className={styles.tag}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
            {item.promptEn && (
              <div className={styles.prompt}>
                <div className={styles.promptBar}>
                  <span className={styles.lang}>
                    <FormattedMessage id="library.public.lang.en" />
                  </span>
                  <span className={styles.spacer} />
                  <button type="button" className={styles.copy} onClick={() => onCopy(item.promptEn ?? '')}>
                    <PathIcon d={paths.copy} size={13} />
                    <FormattedMessage id="library.public.copy" />
                  </button>
                </div>
                <p className={styles.promptText}>{item.promptEn}</p>
              </div>
            )}
            <div className={styles.facts}>
              <div className={styles.fact}>
                <span className={styles.factKey}>
                  <FormattedMessage id="library.public.source" />
                </span>
                <span className={styles.factValue}>
                  <a href={item.source} target="_blank" rel="noreferrer">
                    <FormattedMessage id="library.public.sourceValue" values={{ name: cat.def.attribution.name }} />
                  </a>
                </span>
              </div>
              <div className={styles.fact}>
                <span className={styles.factKey}>
                  <FormattedMessage id="library.public.license" />
                </span>
                <span className={styles.factValue}>
                  <FormattedMessage id={`library.licenseNote.${cat.key}`} />
                </span>
              </div>
            </div>
            <div className={styles.actions}>
              <button type="button" className={cx(styles.primary, motion.press)} onClick={use}>
                <FormattedMessage id={cat.cta} />
              </button>
              <div className={styles.row}>
                <button
                  type="button"
                  className={cx(styles.secondary, motion.hover)}
                  aria-pressed={!!board[item.id]}
                  onClick={() => {
                    const on = !board[item.id];
                    setBoard((b) => ({ ...b, [item.id]: on }));
                    toast.show({
                      message: intl.formatMessage({ id: on ? 'library.public.boardAdded' : 'library.public.boardRemoved' }, { title: item.title }),
                      action: on ? { label: intl.formatMessage({ id: 'library.public.undo' }), onAction: () => setBoard((b) => ({ ...b, [item.id]: false })) } : undefined,
                    });
                  }}
                >
                  <FormattedMessage id={board[item.id] ? 'library.public.onBoard' : 'library.public.addToBoard'} />
                </button>
                <button
                  type="button"
                  className={cx(styles.secondary, motion.hover)}
                  onClick={() => {
                    toast.show({ message: intl.formatMessage({ id: 'library.public.toCanvas' }, { title: item.title }) });
                    void navigate({ to: '/p/$projectId', params: { projectId: 'prj_demo' } });
                  }}
                >
                  <FormattedMessage id="library.public.addToCanvas" />
                </button>
                <button
                  type="button"
                  className={styles.star}
                  aria-label={intl.formatMessage({ id: 'library.public.favorite' })}
                  aria-pressed={!!fav[item.id]}
                  onClick={() => {
                    const on = !fav[item.id];
                    setFav((f) => ({ ...f, [item.id]: on }));
                    toast.show({ message: intl.formatMessage({ id: on ? 'library.public.favAdded' : 'library.public.favRemoved' }) });
                  }}
                >
                  <PathIcon d={paths.star} size={15} />
                </button>
              </div>
              <span className={styles.hint}>
                <FormattedMessage id="library.public.hint" />
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
