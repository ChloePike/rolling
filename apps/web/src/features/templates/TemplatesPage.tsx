import { cx, OptionList, Popover, Skeleton, staggerStyle } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { PromptIcon } from '@/features/prompt';
import { ASPECT_RATIO_OPTIONS, usePref } from '@/lib/prefs';
import { useTemplates } from './api';
import { TemplatePreview } from './TemplatePreview';
import styles from './TemplatesPage.module.css';
import type { TemplateCategory, TemplateSummary } from './types';
import { coverStyle } from './cover';
import { LoadError } from '@/lib/loading';

const CATS: Array<'all' | TemplateCategory> = ['all', 'product', 'explainer', 'drama', 'holiday', 'venue', 'outfit', 'comic'];
const TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)', 'var(--c-tone-moss)', 'var(--c-tone-clay)', 'var(--c-tone-slate)'];

/** Facets: Character, Lines and Duration filter the grid; Aspect ratio is the ratio the template is made in. */
type FacetKey = 'character' | 'lines' | 'aspect' | 'duration';
const FACET_OPTIONS: Record<Exclude<FacetKey, 'aspect'>, readonly string[]> = {
  character: ['any', '1', '2', '3'],
  lines: ['any', 'with', 'without'],
  duration: ['any', 'short', 'medium', 'long'],
};
const FACET_TEST: Record<Exclude<FacetKey, 'aspect'>, (t: TemplateSummary, v: string) => boolean> = {
  character: (t, v) => v === 'any' || (v === '3' ? t.roles >= 3 : t.roles === Number(v)),
  lines: (t, v) => v === 'any' || (v === 'with') === t.hasLines,
  duration: (t, v) => v === 'any' || (v === 'short' ? t.durationSec <= 10 : v === 'medium' ? t.durationSec > 10 && t.durationSec <= 20 : t.durationSec > 20),
};

/** Quick Create with a template (`/create/quick?template=<id>&ratio=<w:h>`). */
export function useUseTemplate() {
  const navigate = useNavigate();
  return (t: TemplateSummary, ratio?: string) =>
    void navigate({ to: '/create/quick', search: { template: t.id, ...(ratio ? { ratio } : {}) } as never });
}

/** “12K” from 10,000 up, otherwise “8,640” (handoff 5 number rules). */
export function formatUses(intl: IntlShape, n: number): string {
  return n >= 10_000 ? intl.formatNumber(n, { notation: 'compact' }) : intl.formatNumber(n);
}

const seconds = (intl: IntlShape, s: number) => intl.formatNumber(s, { style: 'unit', unit: 'second', unitDisplay: 'narrow' });

/** Templates (Templates.dc.html): search, categories, facets, featured picks and the grid. */
export function TemplatesPage() {
  const intl = useIntl();
  const list = useTemplates();
  const { data } = list;
  const loading = list.isPending && !list.isError;
  const [cat, setCat] = useState<(typeof CATS)[number]>('all');
  const [q, setQ] = useState('');
  const defaultRatio = usePref('defaultAspectRatio');
  const [facets, setFacets] = useState<Record<FacetKey, string>>({ character: 'any', lines: 'any', aspect: '', duration: 'any' });
  const ratio = facets.aspect || defaultRatio;
  const [openFacet, setOpenFacet] = useState<FacetKey | null>(null);
  const [preview, setPreview] = useState<TemplateSummary | null>(null);
  const useTemplate = useUseTemplate();
  const query = q.trim().toLowerCase();
  const filtering = facets.character !== 'any' || facets.lines !== 'any' || facets.duration !== 'any';
  const items = data.items.filter(
    (t) =>
      (cat === 'all' || t.category === cat) &&
      (!query || t.name.toLowerCase().includes(query)) &&
      (Object.keys(FACET_TEST) as Array<keyof typeof FACET_TEST>).every((k) => FACET_TEST[k](t, facets[k])),
  );
  const showFeatured = cat === 'all' && !query && !filtering;
  const facetLabel = (k: FacetKey, v: string) =>
    k === 'aspect' ? v : v === 'any' ? intl.formatMessage({ id: 'templates.facet.any' }) : intl.formatMessage({ id: `templates.facet.${k}.${v}` });
  const facetValue: Record<FacetKey, string> = { ...facets, aspect: ratio };

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <h1 className={styles.title}>
            <FormattedMessage id="templates.title" />
          </h1>
          <span className={styles.subtitle}>
            <FormattedMessage id="templates.subtitle" />
          </span>
        </div>
        <label className={styles.search}>
          <PromptIcon name="search" size={15} className={styles.searchIcon} />
          <input
            type="search"
            aria-label={intl.formatMessage({ id: 'templates.search.label' })}
            placeholder={intl.formatMessage({ id: 'templates.search.placeholder' })}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={styles.searchInput}
          />
        </label>
      </div>
      <div className={styles.cats} role="group" aria-label={intl.formatMessage({ id: 'templates.categories' })}>
        {CATS.map((c) => (
          <button key={c} type="button" aria-pressed={c === cat} className={styles.cat} onClick={() => setCat(c)}>
            <FormattedMessage id={`templates.cat.${c}`} />
          </button>
        ))}
      </div>
      <div className={styles.facets}>
        {(['character', 'lines', 'aspect', 'duration'] as const).map((key) => {
          const k = intl.formatMessage({ id: `templates.facet.${key}` });
          const v = facetLabel(key, facetValue[key]);
          const options = key === 'aspect' ? ASPECT_RATIO_OPTIONS : FACET_OPTIONS[key];
          return (
            <Popover
              key={key}
              open={openFacet === key}
              onOpenChange={(o) => setOpenFacet(o ? key : null)}
              label={k}
              role="menu"
              align="start"
              offset={6}
              autoFocus={false}
              className={styles.facetLayer}
              trigger={(p) => (
                <button {...p} type="button" aria-label={intl.formatMessage({ id: 'templates.facet.value' }, { facet: k, value: v })} className={styles.facet}>
                  <span className={styles.facetKey}>{k}</span>
                  {v}
                  <PromptIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
                </button>
              )}
            >
              <OptionList
                label={k}
                value={facetValue[key]}
                options={options.map((o) => ({ value: o, label: facetLabel(key, o) }))}
                onSelect={(o) => {
                  setFacets((f) => ({ ...f, [key]: o }));
                  setOpenFacet(null);
                }}
              />
            </Popover>
          );
        })}
        <span className={styles.flex1} />
        <span className={styles.total}>
          {loading ? <Skeleton text width={150} height={12} /> : <FormattedMessage id="templates.total" values={{ n: data.total }} />}
        </span>
      </div>

      {loading ? <TemplatesSkeleton /> : null}
      {list.isError && list.data === undefined ? <LoadError onRetry={() => list.refetch()} retrying={list.isFetching} /> : null}

      {showFeatured && !loading ? (
        <section aria-label={intl.formatMessage({ id: 'templates.featured' })} className={styles.featured}>
          {data.featured.map((t, i) => (
            <button
              key={t.id}
              type="button"
              aria-haspopup="dialog"
              data-template={t.id}
              className={cx(styles.cardButton, styles.feat, 'rl-stagger')}
              style={staggerStyle(i)}
              data-motion=""
              onClick={() => setPreview(t)}
            >
              <div className={styles.featCover} style={coverStyle(t.coverUrl, i === 0 ? TONES[0]! : TONES[6]!)}>
                <span className={styles.featDur}>{seconds(intl, t.durationSec)}</span>
              </div>
              <div className={styles.featBody}>
                <span className={styles.pick}>
                  <FormattedMessage id="templates.picks" />
                </span>
                <span className={styles.featName}>{t.name}</span>
                <span className={styles.featDesc}>{t.description}</span>
                <span className={styles.flex1} />
                <div className={styles.tags}>
                  {t.tags?.map((g) => (
                    <span key={g} className={styles.tag}>
                      {g}
                    </span>
                  ))}
                </div>
                <span className={styles.featFoot}>
                  <span className={styles.uses}>
                    <FormattedMessage id="templates.uses" values={{ uses: formatUses(intl, t.uses) }} />
                  </span>
                  {/* Pointer shortcut; keyboard users reach Use template in the preview. */}
                  <span
                    className={cx(styles.useBtn, 'rl-press')}
                    data-use-template=""
                    onClick={(e) => {
                      e.stopPropagation();
                      useTemplate(t, ratio);
                    }}
                  >
                    <FormattedMessage id="templates.use" />
                  </span>
                </span>
              </div>
            </button>
          ))}
        </section>
      ) : null}

      {loading || list.isError ? null : <section key={`${cat}:${query}`} aria-label={intl.formatMessage({ id: 'templates.all' })} className={styles.grid}>
        {items.map((t, i) => (
          <button
            key={t.id}
            type="button"
            aria-haspopup="dialog"
            data-template={t.id}
            className={cx(styles.cardButton, styles.card, 'rl-stagger')}
            style={staggerStyle(i)}
            data-motion=""
            onClick={() => setPreview(t)}
          >
            <div className={styles.cover} style={coverStyle(t.coverUrl, TONES[data.items.indexOf(t) % TONES.length]!)}>
              <span className={styles.badges}>
                <span className={styles.badge}>
                  <FormattedMessage id="templates.badge.roles" values={{ n: t.roles }} />
                </span>
                {t.hasLines ? (
                  <span className={styles.badge}>
                    <FormattedMessage id="templates.badge.lines" />
                  </span>
                ) : null}
              </span>
              <span className={styles.dur}>{seconds(intl, t.durationSec)}</span>
            </div>
            <span className={styles.name}>{t.name}</span>
            <span className={styles.meta}>
              <FormattedMessage
                id="templates.meta"
                values={{ roles: t.roles, lines: String(t.hasLines), uses: formatUses(intl, t.uses) }}
              />
            </span>
          </button>
        ))}
        {items.length === 0 ? (
          <p className={styles.empty} data-empty="">
            {data.items.length === 0 ? <FormattedMessage id="templates.none" /> : <FormattedMessage id="templates.empty" values={{ q }} />}
          </p>
        ) : null}
      </section>}
      <TemplatePreview
        template={preview}
        tone={preview ? TONES[Math.max(0, data.items.findIndex((x) => x.id === preview.id)) % TONES.length]! : TONES[0]!}
        ratio={ratio}
        onClose={() => setPreview(null)}
        onUse={(t) => {
          setPreview(null);
          useTemplate(t, ratio);
        }}
      />
    </div>
  );
}

/** Featured picks and the grid while the list loads, shaped like the cards. */
function TemplatesSkeleton() {
  return (
    <>
      <section className={styles.featured} aria-busy="true" data-testid="templates-skeleton">
        {[0, 1].map((i) => (
          <div key={i} className={styles.feat}>
            <Skeleton className={styles.featCover} height="auto" radius={12} />
            <div className={styles.featBody}>
              <Skeleton width={84} height={20} round />
              <Skeleton text width="70%" height={20} />
              <Skeleton text width="90%" height={14} />
              <Skeleton text width="60%" height={14} />
            </div>
          </div>
        ))}
      </section>
      <section className={styles.grid} aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={styles.card}>
            <Skeleton className={styles.cover} height="auto" radius={16} />
            <Skeleton text width="70%" height={16} />
            <Skeleton text width="50%" height={14} />
          </div>
        ))}
      </section>
    </>
  );
}
