import type { CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { FeedItem, MediaRun, ScriptDraft } from '../types';
import styles from './FeedCard.module.css';
import { formatAgo, formatClock } from './format';
import { ToolIcon, type ToolIconName } from './icons';

const ACTION_LABEL: Partial<Record<ToolIconName, string>> = {
  redo: 'tools.feed.action.regenerate',
  sliders: 'tools.feed.action.reuse',
  frame: 'tools.feed.action.toCanvas',
  save: 'tools.feed.action.saveCharacter',
  down: 'tools.feed.action.download',
  star: 'tools.feed.action.favorite',
};

interface Props {
  item: FeedItem;
  index: number;
  onOpen: (item: MediaRun) => void;
  onConfirmDraft: (item: ScriptDraft) => void;
}

export function FeedCard({ item, index, onOpen, onConfirmDraft }: Props) {
  const style = { '--i': index } as CSSProperties;
  if (item.kind === 'draft') {
    return (
      <article className={`${styles.card} ${styles.full}`} style={style} data-feed={item.id}>
        <Draft item={item} onConfirm={() => onConfirmDraft(item)} />
      </article>
    );
  }
  return (
    <article className={styles.card} style={style} data-feed={item.id}>
      <Media item={item} onOpen={() => onOpen(item)} />
    </article>
  );
}

function Media({ item, onOpen }: { item: MediaRun; onOpen: () => void }) {
  const intl = useIntl();
  const running = item.progress !== undefined;
  const pct = running ? intl.formatNumber(item.progress! / 100, { style: 'percent' }) : '';
  return (
    <>
      <button type="button" className={styles.open} aria-label={intl.formatMessage({ id: 'tools.feed.details' })} onClick={onOpen}>
        <div className={styles.tiles} style={{ gridTemplateColumns: item.tiles.length > 1 ? '1fr 1fr' : '1fr' }}>
          {item.tiles.map((t, i) => (
            <div key={i} className={styles.tile} style={{ aspectRatio: item.aspect, background: t.tone }}>
              {t.label && <span className={styles.tileLabel}>{t.label}</span>}
              {!running && item.video && (
                <span className={styles.play}>
                  <ToolIcon name="play" size={14} filled color="#F5F5F5" />
                </span>
              )}
              {running && <span className={styles.pct}>{pct}</span>}
              {!running && item.video && item.durationSec !== undefined && (
                <span className={styles.dur}>{formatClock(intl, item.durationSec)}</span>
              )}
              {running && (
                <span
                  className={styles.bar}
                  style={{ width: `${item.progress}%` }}
                  role="progressbar"
                  aria-valuenow={item.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={intl.formatMessage({ id: 'tools.feed.progress' })}
                />
              )}
            </div>
          ))}
        </div>
      </button>
      <div className={styles.meta}>
        <div className={styles.prompt}>{item.prompt}</div>
        <div className={styles.tags}>
          {item.tags.map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </div>
        {running && (
          <div className={styles.steps}>
            {(item.steps ?? []).map((s) => (
              <span
                key={s.label}
                className={`${styles.step} ${s.state === 'done' ? styles.stepDone : s.state === 'now' ? styles.stepNow : ''}`}
              >
                <ToolIcon name={s.state === 'done' ? 'check' : s.state === 'now' ? 'spinner' : 'circle'} size={11} strokeWidth={3} />
                {s.label}
              </span>
            ))}
            <span className={styles.spacer} />
            <button type="button" className={styles.cancel}>
              <FormattedMessage id="tools.feed.cancel" />
            </button>
          </div>
        )}
        {!running && (
          <div className={styles.done}>
            <span className={styles.time}>{item.finishedAgoMin !== undefined ? formatAgo(intl, item.finishedAgoMin) : ''}</span>
            {item.actions.map((a) => {
              const label = intl.formatMessage({ id: ACTION_LABEL[a] ?? 'tools.feed.action.regenerate' });
              return (
                <button key={a} type="button" className={styles.act} aria-label={label} title={label}>
                  <ToolIcon name={a} size={15} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function Draft({ item, onConfirm }: { item: ScriptDraft; onConfirm: () => void }) {
  return (
    <div className={styles.draft}>
      <div className={styles.draftHead}>
        <span className={styles.draftTitles}>
          <span className={styles.draftTitle}>{item.title}</span>
          <span className={styles.draftMeta}>{item.meta}</span>
        </span>
        <span className={styles.spacer} />
        <span className={styles.badge}>
          <FormattedMessage id="tools.draft.toConfirm" />
        </span>
      </div>
      <div className={styles.lines}>
        {item.lines.map((l) => (
          <div key={l.at} className={styles.line}>
            <span className={styles.lineT}>{l.at}</span>
            <span className={styles.lineText}>
              {l.text}
              {l.exact && (
                <>
                  {' '}
                  <span className={styles.exact}>
                    <FormattedMessage id="tools.draft.exact" />
                  </span>
                </>
              )}
            </span>
            <span className={styles.lineAct}>{l.action}</span>
          </div>
        ))}
      </div>
      <div className={styles.btns}>
        <button type="button" className={styles.primary} onClick={onConfirm}>
          <FormattedMessage id="tools.draft.confirm" />
        </button>
        <button type="button" className={styles.secondary}>
          <FormattedMessage id="tools.draft.revise" />
        </button>
        <button type="button" className={styles.secondary}>
          <FormattedMessage id="tools.draft.rewrite" />
        </button>
      </div>
    </div>
  );
}
