import { cx, Popover, presenceProps, Progress, staggerStyle, usePresence, useToast } from '@rolling/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { transfers, useTransfers, type TransferItem } from '@/lib/transfers';
import { formatBytes, formatEta, isActive, isRunning } from './format';
import styles from './Transfers.module.css';

/** Hide the indicator this long after the last transfer finished. */
const LINGER_MS = 4000;

/**
 * Transfers dock (D-011): a compact indicator with the count and aggregate
 * progress that opens a panel listing every upload and download with
 * progress, speed, ETA and controls. Every tab of the origin shows the same
 * queue (SharedWorker). Hidden while nothing is transferring. Completion and
 * failure toasts come from `useTransferToasts` (./toasts.ts), mounted by the host.
 */
export function TransfersDock() {
  const intl = useIntl();
  const snap = useTransfers();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => snap.items.filter((i) => !i.hidden), [snap.items]);
  const active = items.filter(isActive);
  const lastActiveAt = useRef(0);
  const [, force] = useState(0);
  if (active.length) lastActiveAt.current = Date.now();
  const lingering = !active.length && items.length > 0 && Date.now() - lastActiveAt.current < LINGER_MS;
  useEffect(() => {
    if (active.length || !items.length) return;
    const t = setTimeout(() => force((n) => n + 1), LINGER_MS + 50);
    return () => clearTimeout(t);
  }, [active.length, items.length]);


  const visible = active.length > 0 || lingering || open;
  const presence = usePresence(visible);
  if (!presence.mounted) return null;

  const total = active.reduce((s, i) => s + i.size, 0);
  const done = active.reduce((s, i) => s + i.bytesDone, 0);
  const pct = total ? done / total : 1;
  const attention = active.some((i) => i.status === 'needsFile' || i.status === 'retrying') || items.some((i) => i.status === 'failed');

  return (
    <div className={cx(styles.dock, 'rl-pop')} {...presenceProps(presence.state)} data-testid="transfers-dock" data-mode={snap.mode} data-api={snap.api}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label={intl.formatMessage({ id: 'transfers.panel' })}
        side="top"
        align="end"
        bare
        trigger={(p) => (
          <button {...p} type="button" className={cx(styles.indicator, attention && styles.attention)} aria-label={intl.formatMessage({ id: 'transfers.indicator' }, { active: active.length })}>
            <Ring value={pct} />
            <span className={styles.count} aria-hidden="true">
              <FormattedMessage id="transfers.indicator.short" values={{ active: active.length }} />
            </span>
          </button>
        )}
      >
        <TransfersPanel items={items} paused={snap.paused} online={snap.online} />
      </Popover>
    </div>
  );
}

function Ring({ value }: { value: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className={styles.ring} aria-hidden="true">
      <circle cx="10" cy="10" r={r} className={styles.ringTrack} />
      <circle cx="10" cy="10" r={r} className={styles.ringFill} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))} />
    </svg>
  );
}

export function TransfersPanel({ items, paused, online }: { items: TransferItem[]; paused: boolean; online: boolean }) {
  const intl = useIntl();
  const uploads = items.filter((i) => i.kind === 'upload');
  const uploading = uploads.filter(isRunning).length;
  const queued = uploads.filter((i) => i.status === 'queued').length;
  const downloading = items.filter((i) => i.kind !== 'upload' && isRunning(i)).length;
  const finished = items.some((i) => i.status === 'done' || i.status === 'failed');
  const anyActive = items.some(isActive);
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <h2 className={styles.title}>
            <FormattedMessage id="transfers.panel" />
          </h2>
          <p className={styles.summary} data-testid="transfers-summary">
            <FormattedMessage id="transfers.summary" values={{ uploading, queued }} />
            {downloading ? (
              <>
                {' · '}
                <FormattedMessage id="transfers.summary.downloads" values={{ downloading }} />
              </>
            ) : null}
          </p>
        </div>
        {anyActive ? (
          <button type="button" className={styles.textButton} onClick={() => (paused ? transfers.resume() : transfers.pause())}>
            <FormattedMessage id={paused ? 'transfers.resumeAll' : 'transfers.pauseAll'} />
          </button>
        ) : null}
        {finished ? (
          <button type="button" className={styles.textButton} onClick={() => transfers.clearFinished()}>
            <FormattedMessage id="transfers.clear" />
          </button>
        ) : null}
      </div>
      {!online ? (
        <p className={styles.notice} role="status">
          <FormattedMessage id="transfers.offline" />
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.empty}>
          <FormattedMessage id="transfers.empty" />
        </p>
      ) : (
        <ul className={styles.list} aria-label={intl.formatMessage({ id: 'transfers.panel' })}>
          {[...items].reverse().map((item, i) => (
            <Row key={item.id} item={item} paused={paused} online={online} index={i} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ item, paused, online, index }: { item: TransferItem; paused: boolean; online: boolean; index: number }) {
  const intl = useIntl();
  const toast = useToast();
  const pickRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (item.status !== 'retrying') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [item.status]);
  const name = item.name;
  const pct = item.size ? item.bytesDone / item.size : item.status === 'done' ? 1 : 0;
  const status = statusLine(intl, item, paused, online, now);
  const canPause = ['queued', 'preparing', 'running', 'retrying'].includes(item.status);
  const canResume = item.status === 'paused';

  const onPick = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (pickRef.current) pickRef.current.value = '';
    if (!files.length) return;
    const matched = await transfers.offerFiles(files);
    toast.show({ message: matched.length ? intl.formatMessage({ id: 'transfers.toast.resumed' }, { count: matched.length }) : intl.formatMessage({ id: 'transfers.toast.mismatch' }) });
  };

  return (
    <li className={cx(styles.row, 'rl-stagger')} data-transfer={item.name} data-status={item.status} style={staggerStyle(index)}>
      <span className={styles.kind} aria-hidden="true">
        <KindIcon kind={item.kind} />
      </span>
      <div className={styles.body}>
        <div className={styles.line}>
          <span className={styles.name} title={name}>
            {name}
          </span>
          <div className={styles.actions}>
            {canPause ? (
              <IconBtn label={intl.formatMessage({ id: 'transfers.action.pause' }, { name })} onClick={() => transfers.pause(item.id)} icon="pause" />
            ) : null}
            {canResume ? (
              <IconBtn label={intl.formatMessage({ id: 'transfers.action.resume' }, { name })} onClick={() => transfers.resume(item.id)} icon="play" />
            ) : null}
            {item.status === 'failed' ? (
              <button type="button" className={styles.chip} aria-label={intl.formatMessage({ id: 'transfers.action.retryName' }, { name })} onClick={() => transfers.retry(item.id)}>
                <FormattedMessage id="transfers.action.retry" />
              </button>
            ) : null}
            {item.status === 'needsFile' ? (
              <>
                <button type="button" className={styles.chip} aria-label={intl.formatMessage({ id: 'transfers.action.pickName' }, { name })} onClick={() => pickRef.current?.click()}>
                  <FormattedMessage id="transfers.action.pick" />
                </button>
                <input ref={pickRef} type="file" hidden accept={item.contentType || undefined} onChange={(e) => void onPick(e.target.files)} data-testid="transfers-pick" />
              </>
            ) : null}
            {item.status === 'done' && item.kind === 'download' ? (
              <button type="button" className={styles.chip} aria-label={intl.formatMessage({ id: 'transfers.action.saveName' }, { name })} onClick={() => void transfers.save(item.id)}>
                <FormattedMessage id="transfers.action.save" />
              </button>
            ) : null}
            {item.status !== 'done' ? (
              <IconBtn label={intl.formatMessage({ id: 'transfers.action.cancel' }, { name })} onClick={() => transfers.cancel(item.id)} icon="close" />
            ) : null}
          </div>
        </div>
        {item.status !== 'done' ? (
          <Progress value={pct} label={intl.formatMessage({ id: 'transfers.progress' }, { name, pct })} height={3} color={item.status === 'failed' ? 'var(--c-danger)' : undefined} />
        ) : null}
        <span className={cx(styles.meta, item.status === 'failed' && styles.metaDanger, item.status === 'needsFile' && styles.metaWarn)}>{status}</span>
      </div>
    </li>
  );
}

function statusLine(intl: IntlShape, item: TransferItem, paused: boolean, online: boolean, now: number): string {
  const f = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const bytes = item.size ? f('transfers.bytes', { done: formatBytes(intl, item.bytesDone), total: formatBytes(intl, item.size) }) : formatBytes(intl, item.bytesDone);
  switch (item.status) {
    case 'queued':
      return online ? f('transfers.status.queued') : f('transfers.status.waitingNetwork');
    case 'preparing':
      return online ? f('transfers.status.preparing') : f('transfers.status.waitingNetwork');
    case 'running': {
      if (!online) return `${bytes} · ${f('transfers.status.waitingNetwork')}`;
      const parts = [bytes];
      if (item.speed > 0) parts.push(f('transfers.speed', { speed: formatBytes(intl, item.speed) }));
      if (item.eta != null && item.eta > 0) parts.push(f('transfers.eta', { eta: formatEta(intl, item.eta) }));
      return parts.join(' · ');
    }
    case 'retrying':
      return f('transfers.status.retrying', { seconds: Math.max(1, Math.ceil(((item.nextRetryAt ?? now) - now) / 1000)) });
    case 'paused':
      return `${bytes} · ${paused && !item.userPaused ? f('transfers.status.pausedAll') : f('transfers.status.paused')}`;
    case 'needsFile':
      return f('transfers.status.needsFile', { name: item.name });
    case 'completing':
      return f('transfers.status.completing');
    case 'done':
      return `${formatBytes(intl, item.size)} · ${f(item.kind === 'upload' ? 'transfers.status.uploaded' : 'transfers.status.downloaded')}`;
    case 'failed':
      return f('transfers.status.failed', { reason: errorText(intl, item.error?.code) });
    default:
      return '';
  }
}

function errorText(intl: IntlShape, code?: string) {
  const id = `transfers.error.${code ?? 'generic'}`;
  return intl.messages[id] ? intl.formatMessage({ id }) : intl.formatMessage({ id: 'transfers.error.generic' });
}

function IconBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon: 'pause' | 'play' | 'close' }) {
  return (
    <button type="button" className={styles.iconButton} aria-label={label} title={label} onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon === 'pause' ? <path d="M9 5v14M15 5v14" /> : icon === 'play' ? <path d="M8 5l11 7-11 7z" /> : <path d="M6 6l12 12M18 6L6 18" />}
      </svg>
    </button>
  );
}

function KindIcon({ kind }: { kind: TransferItem['kind'] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'upload' ? <path d="M12 16V4M7 9l5-5 5 5M5 20h14" /> : <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />}
    </svg>
  );
}
