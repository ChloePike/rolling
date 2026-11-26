import { Popover, Skeleton, useToast } from '@rolling/ui';
import { LoadError } from '@/lib/loading';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { ChipGroup, motion, PathIcon, paths, ResultModal, SearchField, type ResultModalItem } from '@/features/account/shared';
import { useActivity } from './api';
import { useQueryClient } from '@tanstack/react-query';
import { ResultViewer, RunConfirm } from '@/features/overlays';
import { assetMediaUrl, isApiError, isMockApi } from '@/features/overlays/backend';
import { downloadAsset } from '@/features/overlays/media';
import { cancelRun, retryRun, startQuote, type SpecQuote } from '@/features/overlays/runs';
import { runError } from '@/features/canvas/api';
import { useSendToCanvas, type IncomingItem } from '@/features/canvas/target';
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
  running: { bg: 'var(--c-accent-soft)', fg: 'var(--c-link)' },
  queued: { bg: 'var(--c-surface-5)', fg: 'var(--c-text-2)' },
  done: { bg: 'var(--c-success-soft)', fg: 'var(--c-success)' },
  partial: { bg: 'var(--c-upgrade-soft)', fg: 'var(--c-upgrade)' },
  failed: { bg: 'var(--c-failed-soft)', fg: 'var(--c-failed)' },
  canceled: { bg: 'var(--c-surface-5)', fg: 'var(--c-text-3)' },
  review: { bg: 'var(--c-upgrade-soft)', fg: 'var(--c-upgrade)' },
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

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)', 'var(--c-tone-moss)'];

export const RANGES = ['last24', 'last7', 'last30', 'all'] as const;
export type ActivityRange = (typeof RANGES)[number];
const RANGE_MINUTES: Record<ActivityRange, number> = { last24: 24 * 60, last7: 7 * 24 * 60, last30: 30 * 24 * 60, all: Infinity };

const SOURCE_ROUTE: Record<RunRow['source'], '/create/quick' | '/create/remix' | '/create/avatar' | '/create/character' | null> = {
  canvas: null,
  quickCreate: '/create/quick',
  remix: '/create/remix',
  avatar: '/create/avatar',
  characters: '/create/character',
};

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function matches(run: RunRow, q: string) {
  if (!q) return true;
  const hay = `${run.name} ${run.ref} ${run.projectTitle ?? ''} ${run.params}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

const STAT_KEYS = ['used', 'running', 'success', 'refunded'] as const;

/** `/activity` (Tasks.dc.html). */
export function ActivityPage({ initialFilter = 'all' }: { initialFilter?: ActivityFilter }) {
  const intl = useIntl();
  const toast = useToast();
  const activity = useActivity();
  const { data } = activity;
  const loading = data === undefined && !activity.isError;
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<ActivityRange>('last7');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [viewing, setViewing] = useState<RunRow | null>(null);
  const navigate = useNavigate();
  const toCanvas = useSendToCanvas();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearInterval(t)), []);
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => {
    if (data) setRuns(data.runs);
  }, [data]);

  const rows = useMemo(
    () =>
      runs.filter(
        (r) => r.minutesAgo <= RANGE_MINUTES[range] && (filter === 'all' || FILTER_STATUSES[filter].includes(r.status)) && matches(r, query.trim()),
      ),
    [runs, filter, query, range],
  );

  const qc = useQueryClient();
  const [retryQuote, setRetryQuote] = useState<{ run: RunRow; quote: SpecQuote } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['activity'] });

  const startRetry = (run: RunRow, quote: SpecQuote) => {
    setRetryQuote(null);
    if (!quote.quoteId) return;
    void startQuote(quote.quoteId).then(
      () => {
        toast.show({ message: intl.formatMessage({ id: 'activity.toast.retried' }, { name: run.name }) });
        refresh();
      },
      (e: unknown) => toast.show({ message: intl.formatMessage({ id: `activity.retryError.${runError(e).code}`, defaultMessage: intl.formatMessage({ id: 'activity.retryError.other' }) }) }),
    );
  };

  /** Real mode: retry re-quotes the run's failed items (`POST /api/runs/:id/retry`), confirmed per threshold. */
  function actReal(run: RunRow, action: RunAction) {
    if (action === 'cancel') {
      void cancelRun(run.id).then(
        (r) => {
          toast.show({ message: intl.formatMessage({ id: 'activity.toast.canceled' }, { name: run.name }) + (r.refunded ? ` ${intl.formatMessage({ id: 'activity.toast.refunded' }, { n: r.refunded })}` : '') });
          refresh();
        },
        () => toast.show({ message: intl.formatMessage({ id: 'activity.retryError.other' }) }),
      );
    } else if (action === 'retry') {
      // `POST /api/runs/:id/retry`: a fresh quote for the failed items with the same spec or nodes (tool and canvas runs).
      void retryRun(run.id).then(
        (q) => {
          if (!q.quoteId) return void toast.show({ message: q.items.find((i) => i.reason)?.reason ?? intl.formatMessage({ id: 'activity.retryError.NOTHING_TO_RUN' }) });
          if (q.needsConfirm) setRetryQuote({ run, quote: q });
          else startRetry(run, q);
        },
        (e: unknown) => {
          if (isApiError(e, 'CONFLICT') && run.source !== 'canvas') {
            // Runs from before stored requests: reopen the tool.
            const to = SOURCE_ROUTE[run.source];
            toast.show({ message: intl.formatMessage({ id: 'activity.toast.retryInTool' }) });
            if (to) void navigate({ to });
            return;
          }
          toast.show({ message: intl.formatMessage({ id: `activity.retryError.${runError(e).code}`, defaultMessage: intl.formatMessage({ id: 'activity.retryError.other' }) }) });
        },
      );
    } else if (action === 'view') {
      setViewing(run);
    } else if (action === 'locate') {
      if (run.projectId) void navigate({ to: '/p/$projectId', params: { projectId: run.projectId } });
      else {
        const to = SOURCE_ROUTE[run.source];
        if (to) void navigate({ to });
      }
    }
  }

  function act(run: RunRow, action: RunAction) {
    if (!isMockApi()) return actReal(run, action);
    if (action === 'cancel') {
      setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, status: 'canceled', credits: 0, progress: undefined } : r)));
      toast.show({ message: intl.formatMessage({ id: 'activity.toast.canceled' }, { name: run.name }) });
    } else if (action === 'retry') {
      // Mock of `POST /api/runs/:id/retry`: queued → running with progress → done.
      setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, status: 'queued', error: undefined, minutesAgo: 0, credits: r.credits || r.refunded, refunded: 0 } : r)));
      toast.show({ message: intl.formatMessage({ id: 'activity.toast.retried' }, { name: run.name }) });
      let p = 0;
      const t = window.setInterval(() => {
        p = Math.min(1, p + 0.25);
        if (p >= 1) {
          window.clearInterval(t);
          setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, status: 'done', progress: undefined } : r)));
          toast.show({
            message: intl.formatMessage({ id: 'activity.toast.done' }, { name: run.name }),
            action: { label: intl.formatMessage({ id: 'activity.action.view' }), onAction: () => setViewing({ ...run, status: 'done' }) },
          });
        } else {
          setRuns((all) => all.map((r) => (r.id === run.id ? { ...r, status: 'running', progress: p } : r)));
        }
      }, 500);
      timers.current.push(t);
    } else if (action === 'view') {
      setViewing(run);
    } else if (action === 'locate') {
      const to = SOURCE_ROUTE[run.source];
      if (to) void navigate({ to });
      // Mock runs carry no project id: the canvas the sidebar item opens (the demo canvas).
      else if (run.projectId) void navigate({ to: '/p/$projectId', params: { projectId: run.projectId } });
      else void navigate({ to: '/canvas' });
    }
  }

  function exportCsv() {
    const t = (id: string) => intl.formatMessage({ id });
    const head = [t('activity.col.activity'), 'ID', t('activity.col.source'), t('activity.col.model'), t('activity.col.status'), t('activity.col.credits'), t('activity.export.refunded')];
    const lines = [head, ...rows.map((r) => [r.name, r.ref, intl.formatMessage({ id: `activity.source.${r.source}` }, { project: r.projectTitle ?? '' }), r.params, t(`activity.status.${r.status}`), r.credits, r.refunded])];
    const blob = new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rolling-activity-${range}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.show({ message: intl.formatMessage({ id: 'activity.toast.exported' }, { n: rows.length }) });
  }

  /**
   * "Edit in canvas" / "Send to canvas": a canvas run's result is already on its canvas, so Edit opens it there;
   * otherwise the result is added as an asset node to the run's project, or to the canvas the user picks.
   */
  function sendRun(run: RunRow, id: 'edit' | 'sendToCanvas') {
    if (id === 'edit' && run.source === 'canvas' && run.projectId) return void navigate({ to: '/p/$projectId', params: { projectId: run.projectId } });
    if (!isMockApi() && !run.assetId) {
      if (run.projectId) return void navigate({ to: '/p/$projectId', params: { projectId: run.projectId } });
      return void toast.show({ message: intl.formatMessage({ id: 'canvas.target.noResult' }) });
    }
    const item: IncomingItem = {
      name: run.name,
      media: run.mediaKind ?? (/Seedream/.test(run.params) ? 'image' : 'video'),
      assetId: run.assetId ?? null,
      refId: run.assetId ?? run.id,
      source: 'generated',
      label: run.params,
    };
    toCanvas.send(item, { projectId: run.projectId });
  }

  const viewItem: ResultModalItem | null = viewing
    ? {
        title: viewing.name,
        prompt: viewing.name,
        aspect: viewing.source === 'avatar' ? '9/16' : viewing.source === 'characters' ? '2/3' : '16/9',
        kind: /Seedream/.test(viewing.params) ? 'image' : 'video',
        minutesAgo: viewing.minutesAgo,
        params: [
          { label: intl.formatMessage({ id: 'activity.col.model' }), value: viewing.params },
          { label: intl.formatMessage({ id: 'activity.col.credits' }), value: intl.formatNumber(viewing.credits) },
        ],
      }
    : null;

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
          color: 'var(--c-link)',
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

      <div className={styles.stats} aria-busy={loading || undefined}>
        {loading
          ? STAT_KEYS.map((key) => (
              <div key={key} className={styles.stat} data-testid="stat-skeleton">
                <span className={styles.statKey}>
                  <FormattedMessage id={`activity.stat.${key}`} />
                </span>
                <Skeleton width={72} height={26} />
                <Skeleton text width="70%" height={12} />
              </div>
            ))
          : null}
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
        <Popover
          open={rangeOpen}
          onOpenChange={setRangeOpen}
          role="listbox"
          label={intl.formatMessage({ id: 'activity.range.label' })}
          align="end"
          offset={6}
          className={styles.rangeMenu}
          trigger={(tp) => (
            <button {...tp} type="button" className={cx(styles.ghost, motion.hover)}>
              <FormattedMessage id={`activity.range.${range}`} />
              <PathIcon d={paths.chevronDown} size={12} strokeWidth={2.4} />
            </button>
          )}
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="option"
              aria-selected={r === range}
              className={styles.rangeOption}
              onClick={() => {
                setRange(r);
                setRangeOpen(false);
              }}
            >
              <FormattedMessage id={`activity.range.${r}`} />
              {r === range && <PathIcon d={paths.check} size={13} strokeWidth={2.4} />}
            </button>
          ))}
        </Popover>
        <button type="button" className={cx(styles.ghost, motion.hover)} onClick={exportCsv}>
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
              {loading
                ? [0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className={cx(styles.cols, styles.row)} role="row" aria-hidden="true" data-testid="row-skeleton">
                      <Skeleton text height={14} width="80%" />
                      <Skeleton text height={14} width="60%" />
                      <Skeleton text height={14} width="70%" />
                      <Skeleton height={22} width={72} round />
                      <Skeleton text height={14} width={40} />
                      <Skeleton text height={14} width={56} />
                      <span />
                    </div>
                  ))
                : null}
              {activity.isError && !data ? <LoadError onRetry={() => activity.refetch()} retrying={activity.isFetching} /> : null}
              {data && rows.length === 0 && (
                <div className={cx(styles.empty, motion.enter)} role="row" data-empty="">
                  <span role="cell">
                    <FormattedMessage id={runs.length === 0 ? 'activity.none' : 'activity.empty'} />
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {!isMockApi() ? (
        <>
          <ResultViewer
            open={!!viewing}
            onOpenChange={(o) => !o && setViewing(null)}
            title={viewing?.name ?? ''}
            author={intl.formatMessage({ id: 'activity.viewer.you' })}
            createdAt={new Date(Date.now() - (viewing?.minutesAgo ?? 0) * 60_000)}
            aspectRatio="9/16"
            mediaKind={viewing?.mediaKind ?? 'video'}
            versions={viewing ? [{ id: viewing.id, label: 'v1' }] : []}
            versionId={viewing?.id ?? ''}
            onVersionChange={() => {}}
            src={viewing?.assetId ? assetMediaUrl(viewing.assetId) : undefined}
            prompt={viewing?.name ?? ''}
            params={viewItem?.params ?? []}
            assets={[]}
            actions={[{ id: 'edit' }, ...(viewing?.assetId ? [{ id: 'sendToCanvas' as const }] : []), { id: 'download' }]}
            onAction={(id) => {
              const v = viewing;
              if (!v) return;
              if (id === 'edit' || id === 'sendToCanvas') {
                setViewing(null);
                sendRun(v, id);
              } else if (id === 'download' && v.assetId) {
                toast.show({ message: intl.formatMessage({ id: 'activity.toast.downloaded' }) });
                void downloadAsset(v.assetId, v.name).catch((e: unknown) => isApiError(e) && toast.show({ message: e.message }));
              }
            }}
          />
          <RunConfirm
            open={!!retryQuote}
            onOpenChange={(o) => !o && setRetryQuote(null)}
            variant="single"
            rows={retryQuote ? retryQuote.quote.items.filter((i) => i.action === 'run').map((i) => ({ id: i.nodeId ?? i.ref, name: i.title || retryQuote.run.name, meta: i.modelName ?? i.model ?? '', kind: (i.kind === 'image' ? 'image' : 'video') as 'image' | 'video', state: 'run' as const, cost: i.credits })) : []}
            balance={retryQuote?.quote.balance ?? 0}
            actionLabel={intl.formatMessage({ id: 'activity.action.retry' })}
            eta={intl.formatMessage({ id: 'activity.retryEta' })}
            onConfirm={() => retryQuote && startRetry(retryQuote.run, retryQuote.quote)}
          />
        </>
      ) : null}
      {toCanvas.dialog}
      <ResultModal
        item={isMockApi() ? viewItem : null}
        onClose={() => setViewing(null)}
        onAction={(id) => {
          const v = viewing;
          setViewing(null);
          if ((id === 'sendToCanvas' || id === 'edit') && v) sendRun(v, id);
          else toast.show({ message: intl.formatMessage({ id: 'activity.toast.downloaded' }) });
        }}
      />
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
