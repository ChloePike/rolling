import { cx, staggerStyle } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { PromptIcon } from '../prompt';
import { useTemplates } from './api';
import styles from './TemplatesPage.module.css';
import type { TemplateCategory } from './types';

const CATS: Array<'all' | TemplateCategory> = ['all', 'product', 'explainer', 'drama', 'holiday', 'venue', 'outfit', 'comic'];
const FACETS = [
  { key: 'character', value: 'any' },
  { key: 'lines', value: 'any' },
  { key: 'aspect', value: '9:16' },
  { key: 'duration', value: 'any' },
] as const;
const TONES = ['#26232A', '#1F2628', '#202330', '#28251F', '#26262A', '#1F2622', '#2A2420', '#22262E'];

/** “12K” from 10,000 up, otherwise “8,640” (handoff 5 number rules). */
export function formatUses(intl: IntlShape, n: number): string {
  return n >= 10_000 ? intl.formatNumber(n, { notation: 'compact' }) : intl.formatNumber(n);
}

const seconds = (intl: IntlShape, s: number) => intl.formatNumber(s, { style: 'unit', unit: 'second', unitDisplay: 'narrow' });

/** Templates (Templates.dc.html): search, categories, facets, featured picks and the grid. */
export function TemplatesPage() {
  const intl = useIntl();
  const { data } = useTemplates();
  const [cat, setCat] = useState<(typeof CATS)[number]>('all');
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const items = data.items.filter((t) => (cat === 'all' || t.category === cat) && (!query || t.name.toLowerCase().includes(query)));
  const showFeatured = cat === 'all' && !query;

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
        {FACETS.map((f) => {
          const k = intl.formatMessage({ id: `templates.facet.${f.key}` });
          const v = f.value === 'any' ? intl.formatMessage({ id: 'templates.facet.any' }) : f.value;
          return (
            <button
              key={f.key}
              type="button"
              aria-haspopup="listbox"
              aria-label={intl.formatMessage({ id: 'templates.facet.value' }, { facet: k, value: v })}
              className={styles.facet}
            >
              <span className={styles.facetKey}>{k}</span>
              {v}
              <PromptIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
            </button>
          );
        })}
        <span className={styles.flex1} />
        <span className={styles.total}>
          <FormattedMessage id="templates.total" values={{ n: data.total }} />
        </span>
      </div>

      {showFeatured ? (
        <section aria-label={intl.formatMessage({ id: 'templates.featured' })} className={styles.featured}>
          {data.featured.map((t, i) => (
            <Link
              key={t.id}
              to="/create/quick"
              className={cx(styles.feat, 'rl-stagger')}
              style={staggerStyle(i)}
              data-motion=""
            >
              <div className={styles.featCover} style={{ background: i === 0 ? TONES[0] : TONES[6] }}>
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
                  <span className={cx(styles.useBtn, 'rl-press')}>
                    <FormattedMessage id="templates.use" />
                  </span>
                </span>
              </div>
            </Link>
          ))}
        </section>
      ) : null}

      <section key={`${cat}:${query}`} aria-label={intl.formatMessage({ id: 'templates.all' })} className={styles.grid}>
        {items.map((t, i) => (
          <Link
            key={t.id}
            to="/create/quick"
            className={cx(styles.card, 'rl-stagger')}
            style={staggerStyle(i)}
            data-motion=""
          >
            <div className={styles.cover} style={{ background: TONES[data.items.indexOf(t) % TONES.length] }}>
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
          </Link>
        ))}
        {items.length === 0 ? (
          <p className={styles.empty}>
            <FormattedMessage id="templates.empty" values={{ q }} />
          </p>
        ) : null}
      </section>
    </div>
  );
}
