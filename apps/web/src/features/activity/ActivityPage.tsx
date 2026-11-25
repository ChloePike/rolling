import { useToast } from '@rolling/ui';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { ChipGroup, motion, PathIcon, paths, SearchField } from '../account/shared';
import { useActivity } from './api';
import type { RunAction, RunRow, RunStatus } from './types';
import styles from './Activity.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

export const FILTERS = ['all', 'running', 'done', 'failed', 'canceled'] as const;
export type ActivityFilter = (typeof FILTERS)[number];

const FILTER_STATUSES: Record<Exclude<ActivityFilter, 'all'>, RunStatus[]> = {
  running: ['running', 'queued'],
  done: ['done', 'partial'],
  failed: ['failed', 'review'],
  canceled: ['canceled'],
};

/** Badge colors from Tasks.dc.html. */
const STATUS_STYLE: Record<RunStatus, { bg: string; fg: string }> = {
  running: { bg: 'rgba(59,130,246,.16)', fg: '#93C5FD' },
  queued: { bg: '#26262A', fg: '#C8C8CC' },
  done: { bg: 'rgba(34,197,94,.14)', fg: '#4ADE80' },
  partial: { bg: 'rgba(255,197,61,.14)', fg: '#FFC53D' },
  failed: { bg: 'rgba(255,77,77,.12)', fg: '#FF7A7A' },
  canceled: { bg: '#26262A', fg: '#9A9AA0' },
  review: { bg: 'rgba(255,197,61,.14)', fg: '#FFC53D' },
};

const ACTIONS: Record<RunStatus, RunAction[]> = {
  running: ['cancel', 'locate'],
  queued: ['cancel'],
  done: ['view'],
  partial: ['view', 'retry'],
  failed: ['retry'],
  review: ['locate'],
  canceled: ['view'],
};

const TONES = ['#202330', '#26232A', '#1F2628', '#28251F', '#26262A', '#1F2622'];

function matches(run: RunRow, q: string) {
  if (!q) return true;
  const hay = `${run.name} ${run.ref} ${run.projectTitle ?? ''} ${run.params}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

/** `/activity` (Tasks.dc.html). */
export function ActivityPage({ initialFilter = 'all' }: { initialFilter?: ActivityFilter }) {
  const intl = useIntl();
  const toast = useToast();
  const { data } = useActivity();
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter);
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => {
    if (data) setRuns(data.runs);
  }, [data]);

  const rows = useMemo(
    () =>
      runs.filter((r) => (filter === 'all' || FILTER_STATUSES[filter].includes(r.status)) && matches(r, query.trim())),
    [runs, filter, query],
  );

  function act(run: RunRow, action: RunAction) {
    if (action === 'cancel') {
      setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, status: 'canceled', credits: 0, progress: undefined } : r)));
      toast.show({ message: intl.formatMessage({ id: 'activity.toast.canceled' }, { name: run.name }) });
    } else if (action === 'retry') {
      setRuns((all) =>
        all.map((r) => (r.id === run.id ? { ...r, status: 'queued', error: undefined, minutesAgo: 0 } : r)),
      );
      toast.show({ message: intl.formatMessage({ id: 'activity.toast.retried' }, { name: run.name }) });
    }
  }

  const s = data?.stats;
  const stats = s
    ? [
        {
          key: 'used',
          value: intl.formatNumber(s.usedThisMonth),
          note: intl.formatMessage(
            { id: s.usedChange <= 0 ? 'activity.stat.used.down' : 'activity.stat.used.up' },
            { pct: Math.abs(s.usedChange) },
          ),
          color: 'var(--c-text-1)',
        },
        {
          key: 'running',
          value: intl.formatNumber(s.running),
          note: intl.formatMessage({ id: 'activity.stat.running.note' }, { minutes: s.runningEtaMinutes }),
          color: '#93C5FD',
        },
        {
          key: 'success',
          value: intl.formatNumber(s.successRate, { style: 'percent' }),
          note: intl.formatMessage({ id: 'activity.stat.success.note' }, { runs: s.runsLast7Days }),
          color: 'var(--c-success)',
        },
        {
          key: 'refunded',
          value: intl.formatNumber(s.refunded),
          note: intl.formatMessage({ id: 'activity.stat.refunded.note' }),
          color: 'var(--c-text-2)',
        },
      ]
    : [];

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <h1 className={styles.title}>
            <FormattedMessage id="activity.title" />
          </h1>
          <span className={styles.lead}>
            <FormattedMessage id="activity.lead" />
          </span>
        </div>
        <SearchField
          placeholder={intl.formatMessage({ id: 'activity.search' })}
          value={query}
          onChange={setQuery}
        />
      </div>

      <div className={styles.stats}>
        {stats.map((st, i) => (
          <div key={st.key} className={cx(styles.stat, motion.stagger)} style={{ '--i': i } as CSSProperties}>
            <span className={styles.statKey}>
              <FormattedMessage id={`activity.stat.${st.key}`} />
            </span>
            <span className={styles.statValue} style={{ color: st.color }}>
              {st.value}
            </span>
            <span className={styles.statNote}>{st.note}</span>
          </div>
        ))}
      </div>

      <div className={styles.bar}>
        <ChipGroup
          label={intl.formatMessage({ id: 'activity.filters' })}
          options={FILTERS.map((f) => ({ value: f, label: intl.formatMessage({ id: `activity.filter.${f}` }) }))}
          value={filter}
          onChange={setFilter}
        />
        <span className={styles.spacer} />
        <button type="button" className={cx(styles.ghost, motion.hover)} aria-haspopup="menu">
          <FormattedMessage id="activity.range.last7" />
          <PathIcon d={paths.chevronDown} size={12} strokeWidth={2.4} />
        </button>
        <button type="button" className={cx(styles.ghost, motion.hover)}>
          <FormattedMessage id="activity.export" />
        </button>
      </div>

      <div className={styles.card}>
        <div className={styles.scroll}>
          <div className={styles.table} role="table" aria-label={intl.formatMessage({ id: 'activity.title' })}>
            <div className={cx(styles.cols, styles.th)} role="row">
              <span role="columnheader"><FormattedMessage id="activity.col.activity" /></span>
              <span role="columnheader"><FormattedMessage id="activity.col.source" /></span>
              <span role="columnheader"><FormattedMessage id="activity.col.model" /></span>
              <span role="columnheader"><FormattedMessage id="activity.col.status" /></span>
              <span role="columnheader" className={styles.right}><FormattedMessage id="activity.col.credits" /></span>
              <span role="columnheader"><FormattedMessage id="activity.col.time" /></span>
              <span role="columnheader"><span className="rl-visually-hidden"><FormattedMessage id="activity.col.actions" /></span></span>
            </div>
            <div key={`${filter}:${query}`} role="rowgroup">
              {rows.map((run, i) => (
                <Row key={run.id} run={run} index={i} onAction={act} />
              ))}
              {data && rows.length === 0 && (
                <div className={cx(styles.empty, motion.enter)} role="row">
                  <span role="cell">
                    <FormattedMessage id="activity.empty" />
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ run, index, onAction }: { run: RunRow; index: number; onAction: (r: RunRow, a: RunAction) => void }) {
  const intl = useIntl();
  const st = STATUS_STYLE[run.status];
  const estimate = run.status === 'running' || run.status === 'queued';
  const cost = run.credits ? (estimate ? `~${intl.formatNumber(run.credits)}` : `-${intl.formatNumber(run.credits)}`) : '0';
  const costNote = estimate
    ? 'activity.cost.estimate'
    : run.status === 'review'
      ? 'activity.cost.reviewing'
      : run.status === 'failed' || run.status === 'canceled'
        ? 'activity.cost.refunded'
        : run.refunded
          ? 'activity.cost.chargedRefunded'
          : 'activity.cost.charged';
  const statusLabel = intl.formatMessage({ id: `activity.status.${run.status}` });
  return (
    <div className={cx(styles.rowWrap, motion.stagger)} style={{ '--i': index } as CSSProperties} data-run-status={run.status}>
      <div className={cx(styles.cols, styles.row)} role="row">
        <span className={styles.what} role="cell">
          <span className={styles.thumb} style={{ background: TONES[index % TONES.length] }} />
          <span className={styles.whatText}>
            <span className={styles.name}>{run.name}</span>
            <span className={styles.ref}>{run.ref}</span>
          </span>
        </span>
        <span className={styles.src} role="cell">
          <FormattedMessage id={`activity.source.${run.source}`} values={{ project: run.projectTitle ?? '' }} />
        </span>
        <span className={styles.params} role="cell">
          {run.params}
        </span>
        <span className={styles.status} role="cell">
          <span className={styles.badge} style={{ background: st.bg, color: st.fg }}>
            {statusLabel}
          </span>
          {run.status === 'running' && run.progress !== undefined && (
            <span
              className={styles.track}
              role="progressbar"
              aria-label={intl.formatMessage({ id: 'activity.progress' }, { name: run.name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(run.progress * 100)}
              aria-valuetext={intl.formatNumber(run.progress, { style: 'percent' })}
            >
              <span className={cx(styles.fill, motion.progress)} style={{ width: `${run.progress * 100}%` }} />
            </span>
          )}
        </span>
        <span className={styles.cost} role="cell">
          <span className={styles.costValue} style={{ color: run.credits ? 'var(--c-text-1)' : 'var(--c-text-4)' }}>
            {cost}
          </span>
          <span className={styles.costNote}>
            <FormattedMessage id={costNote} values={{ charged: run.credits, refunded: run.refunded }} />
          </span>
        </span>
        <span className={styles.time} role="cell">
          <Ago minutes={run.minutesAgo} />
        </span>
        <span className={styles.actions} role="cell">
          {ACTIONS[run.status].map((a) => (
            <button
              key={a}
              type="button"
              className={cx(styles.act, a === 'retry' && styles.actPrimary, a === 'retry' ? motion.press : motion.hover)}
              aria-label={intl.formatMessage({ id: `activity.action.${a}.label` }, { name: run.name })}
              onClick={() => onAction(run, a)}
            >
              <FormattedMessage id={`activity.action.${a}`} />
            </button>
          ))}
        </span>
      </div>
      {run.status === 'failed' && run.error && (
        <div className={styles.error} role="note">
          <PathIcon d={paths.alert} size={15} />
          <span className={styles.errorText}>{run.error}</span>
          <span className={styles.refund}>
            <FormattedMessage id="activity.refunded" values={{ n: run.refunded }} />
          </span>
        </div>
      )}
    </div>
  );
}

function Ago({ minutes }: { minutes: number }) {
  if (minutes < 1) return <FormattedMessage id="activity.time.now" />;
  if (minutes < 60) return <FormattedMessage id="activity.time.minutes" values={{ n: minutes }} />;
  if (minutes < 60 * 24) return <FormattedMessage id="activity.time.hours" values={{ n: Math.floor(minutes / 60) }} />;
  if (minutes < 60 * 48) return <FormattedMessage id="activity.time.yesterday" />;
  return <FormattedMessage id="activity.time.days" values={{ n: <FormattedNumber value={Math.floor(minutes / 1440)} /> }} />;
}
