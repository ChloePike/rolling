import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { ToolModel } from './models';
import type { ComposerPill, FeedItem, MediaRun, ParamKind, PickerKind } from '../types';
import { Composer, type ComposerProps } from './Composer';
import { FeedCard } from './FeedCard';
import { ToolModelPicker, ToolParamPopover, ToolPaywall, ToolResultViewer, ToolRunConfirm } from './overlays';
import { mockIsMember } from './plan';
import { SettingsGroup, type SettingsGroupDef } from './SettingsGroup';
import styles from './ToolLayout.module.css';
import { usePresence } from './usePresence';

export type ToolOverlay = 'model' | 'params' | 'confirm' | 'viewer' | 'paywall';
type Filter = 'all' | 'running' | 'saved';
const FILTERS: Filter[] = ['all', 'running', 'saved'];

export interface ToolLayoutProps {
  testId: string;
  title: string;
  count: string;
  /** Minimum feed column width, px. */
  feedMin: number;
  feed: FeedItem[];
  /** Left panel cards shown in both modes. */
  aside: ReactNode;
  advanced: boolean;
  advGroups: SettingsGroupDef[];
  composer: Omit<ComposerProps, 'openOverlay' | 'onPill' | 'onSend' | 'onRefine'>;
  pickerKind: PickerKind;
  /** Picker list, from `useToolModels`. */
  models: ToolModel[];
  paramKind: ParamKind;
  /** Selected model name ("Auto" for Auto). */
  model: string;
  onModel: (name: string) => void;
  confirm: { cost: number; label: string };
  viewerAspect: string;
  initialOverlay?: ToolOverlay | null;
  /** Active plan (D-007). Defaults to the membership mock. */
  isMember?: boolean;
}

/** Shared layout of Quick Create, Remix, Avatar and Characters: left panel, history feed, floating composer. */
export function ToolLayout(p: ToolLayoutProps) {
  const intl = useIntl();
  const [overlay, setOverlay] = useState<ToolOverlay | null>(p.initialOverlay ?? null);
  const [filter, setFilter] = useState<Filter>('all');
  const adv = usePresence(p.advanced, 140);
  const pillsRef = useRef<HTMLDivElement>(null);
  const close = () => setOverlay(null);
  const [memberMock] = useState(mockIsMember);
  const isMember = p.isMember ?? memberMock;
  // Generate and the agent path need a plan; non-members get the join paywall and keep their text.
  const spend = () => setOverlay(isMember ? 'confirm' : 'paywall');
  const agent = () => !isMember && setOverlay('paywall');
  const toggle = (o: ToolOverlay) => setOverlay((cur) => (cur === o ? null : o));

  // The model pill opens the model picker; every other pill opens the one settings popover.
  const onPill = (_pill: ComposerPill, i: number) => toggle(i === 0 ? 'model' : 'params');

  const visible = p.feed.filter((it) => {
    if (filter === 'all') return true;
    const running = it.kind === 'media' && it.progress !== undefined;
    return filter === 'running' ? running : it.kind === 'media' && !running;
  });

  return (
    <div className={styles.root} data-testid={p.testId} data-mode={p.advanced ? 'advanced' : 'simple'}>
      <aside className={styles.aside} aria-label={intl.formatMessage({ id: 'tools.aside.label' })}>
        {p.aside}
        {adv.mounted && (
          <>
            <div className={`${styles.advRule} ${adv.state === 'enter' ? styles.advEnter : styles.advExit}`}>
              <FormattedMessage id="tools.adv.title" />
            </div>
            {p.advGroups.map((g, i) => (
              <SettingsGroup
                key={g.id}
                def={g}
                className={adv.state === 'enter' ? styles.advEnter : styles.advExit}
                style={{ '--i': Math.min(i + 1, 5) } as CSSProperties}
              />
            ))}
          </>
        )}
      </aside>
      <section className={styles.section} aria-label={intl.formatMessage({ id: 'tools.history.label' })}>
        <div className={styles.scroll}>
          <div className={styles.inner}>
            <div className={styles.head}>
              <h1 className={styles.title}>{p.title}</h1>
              <span className={styles.count}>{p.count}</span>
              <span className={styles.spacer} />
              <div role="tablist" aria-label={intl.formatMessage({ id: 'tools.filter.label' })} className={styles.tabs}>
                {FILTERS.map((f) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f} className={styles.tab} onClick={() => setFilter(f)}>
                    <FormattedMessage id={`tools.filter.${f}`} />
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.grid} style={{ '--feed-min': `${p.feedMin}px` } as CSSProperties}>
              {visible.map((it, i) => (
                <FeedCard
                  key={it.id}
                  item={it}
                  index={i}
                  onOpen={(_run: MediaRun) => setOverlay('viewer')}
                  onConfirmDraft={spend}
                />
              ))}
            </div>
          </div>
        </div>
        <Composer {...p.composer} pillsRef={pillsRef} openOverlay={overlay === 'model' || overlay === 'params' ? overlay : null} onPill={onPill} onSend={spend} onRefine={agent} />
        <ToolModelPicker
          open={overlay === 'model'}
          kind={p.pickerKind}
          models={p.models}
          selected={p.model}
          onPick={(name) => {
            p.onModel(name);
            close();
          }}
          onClose={close}
          anchorClassName={styles.anchor}
          anchorRef={pillsRef}
        />
        <ToolParamPopover open={overlay === 'params'} kind={p.paramKind} onClose={close} anchorClassName={styles.anchor} anchorRef={pillsRef} />
      </section>
      <ToolRunConfirm open={overlay === 'confirm'} cost={p.confirm.cost} label={p.confirm.label} views={p.paramKind === 'image'} onClose={close} />
      <ToolPaywall open={overlay === 'paywall'} onClose={close} />
      <ToolResultViewer open={overlay === 'viewer'} aspect={p.viewerAspect} onClose={close} />
    </div>
  );
}
