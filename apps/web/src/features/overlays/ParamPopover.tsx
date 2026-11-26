import type { PlanId } from '@rolling/core/pricing/config';
import { cx, presenceProps, SegmentedControl, Skeleton, Switch, useIndicator, usePresence, type SegmentedOption } from '@rolling/ui';
import { useId, useRef, type CSSProperties, type RefObject } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Svg } from './icons';
import { isMockApi, mockData } from '@/lib/api/mode';
import { defaultImageParams, defaultVideoParams } from './params';
import styles from './ParamPopover.module.css';
import { PlanLock, planLockInfo } from './PlanLock';
import type { ImageParams, VideoAspect, VideoParams } from './types';
import { useDismiss } from './useDismiss';
import { openUpgrade } from '@/lib/upgrade/store';

interface ParamPopoverCommon {
  /**
   * Quoted credits for the current settings (from the quote API). `null`: no
   * quote yet (a small skeleton, never a guessed number). Omitted: mock mode
   * uses the design's estimator; real mode shows the skeleton.
   */
  cost?: number | null;
  /** Typical wait, e.g. "2 min". Mock mode defaults like the design (video 2–3 min, image 15s); real mode omits it unless given. */
  eta?: string;
  /** Reset to defaults; when omitted the popover resets to the design defaults via `onValueChange`. */
  onReset?: () => void;
  /** Close button, Escape and pointer down outside. */
  onClose?: () => void;
  /** Visible state; animates in 200ms and out 140ms. Default true. */
  open?: boolean;
  /** Where the panel sits relative to its trigger; sets the entry direction. Default `above`. */
  placement?: 'above' | 'below';
  /** Trigger element, ignored by outside-click dismissal. */
  anchorRef?: RefObject<HTMLElement | null>;
  dismissOnOutside?: boolean;
  /**
   * The workspace's plan (D-006). Resolutions above its cap stay visible but
   * locked, with the lowest plan that unlocks them. Omit to show no plan locks.
   */
  plan?: PlanId;
  /**
   * A locked resolution was picked (D-006). Locked options stay clickable (lock
   * badge kept). By default the shared upgrade modal opens ("1080p needs Plus")
   * and the pick is applied once the plan is active; pass this to handle it
   * yourself (called with the plan that unlocks it and the option).
   */
  onLockedPick?: (plan: PlanId, value: string) => void;
  /**
   * Options from the selected model's capabilities (catalog). A list replaces
   * the design's options; an empty list (or `counts: null`, `quality: false`)
   * hides that setting. Omitted keys keep the design's options.
   */
  options?: ParamOptions;
  className?: string;
  style?: CSSProperties;
}

export interface ParamOptions {
  ratios?: readonly string[];
  /** Video resolutions or image sizes. */
  resolutions?: readonly string[];
  /** Video lengths, e.g. `5s`. */
  durations?: readonly string[];
  counts?: readonly string[] | null;
  /** Image quality (standard / high); false hides it. */
  quality?: boolean;
}

export interface VideoParamPopoverProps extends ParamPopoverCommon {
  kind: 'video';
  value: VideoParams;
  onValueChange: (value: VideoParams) => void;
  /** Options the selected model cannot do (shown disabled, "Not supported on this model"). Default: 30s. Plan caps use `plan`. */
  unsupported?: { resolution?: VideoParams['resolution'][]; duration?: VideoParams['duration'][]; count?: VideoParams['count'][] };
  /** Note next to Duration, e.g. "Max 15s on this model". Pass null to hide. */
  durationNote?: string | null;
  /** Show the Generate audio switch (default true). */
  audioSupported?: boolean;
}

export interface ImageParamPopoverProps extends ParamPopoverCommon {
  kind: 'image';
  value: ImageParams;
  onValueChange: (value: ImageParams) => void;
  /** Options the selected model cannot do (shown disabled, "Not supported on this model"). Plan caps use `plan`. */
  unsupported?: { size?: ImageParams['size'][]; count?: ImageParams['count'][] };
}

/** Props: `kind` selects video or image settings (ParamPopover.dc.html `kind`). */
export type ParamPopoverProps = VideoParamPopoverProps | ImageParamPopoverProps;

/** Tile size of a ratio the table doesn't list (fits the same 20×18 box). */
function ratioBox(r: string): [number, number] {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r);
  if (!m) return [14, 14];
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= b ? [20, Math.max(6, Math.round((20 * b) / a))] : [Math.max(6, Math.round((18 * a) / b)), 18];
}

const RATIOS: ReadonlyArray<[VideoAspect, number, number]> = [
  ['Auto', 14, 14],
  ['9:16', 10, 17],
  ['16:9', 20, 11],
  ['1:1', 14, 14],
  ['4:3', 18, 13],
  ['3:4', 13, 18],
];

/**
 * Generation settings popover (ParamPopover.dc.html): aspect ratio tiles,
 * grouped segmented controls, the audio switch (video) and a live cost line.
 * Selection thumbs slide (200ms); the panel pops in from its trigger side.
 */
export function ParamPopover(props: ParamPopoverProps) {
  const { open = true, placement = 'above', onClose, anchorRef, dismissOnOutside = true, className, style } = props;
  const intl = useIntl();
  const presence = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef<HTMLDivElement>(null);
  const ratioLabelId = useId();
  useDismiss(open, onClose, panelRef, anchorRef, dismissOnOutside);
  const ratioThumb = useIndicator(ratioRef, `${presence.mounted}-${props.value.aspectRatio}`, '[aria-checked="true"]');
  if (!presence.mounted) return null;

  const t = (id: string) => intl.formatMessage({ id: `overlays.params.${id}` });
  const unsupported = t('unsupported');

  /** D-006: options above the plan's cap are disabled and show the plan that unlocks them. */
  const withPlanLocks = <T extends string>(options: Array<SegmentedOption<T>>, kind: 'video' | 'image'): Array<SegmentedOption<T>> =>
    options.map((o) => {
      const lock = props.plan ? planLockInfo(intl, props.plan, kind, o.value) : null;
      if (!lock) return o;
      return {
        ...o,
        disabled: false,
        disabledReason: lock.reason,
        ariaLabel: lock.label,
        label: (
          <span className={styles.locked}>
            {o.value}
            <PlanLock plan={lock.plan} />
          </span>
        ),
      };
    });

  /** Picking a locked option asks for the upgrade instead of selecting it. */
  const unlessLocked = <T extends string>(kind: 'video' | 'image', pick: (value: T) => void) => (value: T) => {
    const lock = props.plan ? planLockInfo(intl, props.plan, kind, value) : null;
    if (!lock) return pick(value);
    if (props.onLockedPick) return props.onLockedPick(lock.plan, value);
    // One way in: the upgrade modal, then the picked option applies (owner request: no page change).
    openUpgrade({ kind: 'resolution', value, media: kind }, { onResume: () => pick(value) });
  };
  const opt = props.options ?? {};
  const shown = <T extends string>(design: readonly T[], list: readonly string[] | undefined): T[] => (list ? (list as T[]) : [...design]);
  const ratioTiles: ReadonlyArray<[VideoAspect, number, number]> = opt.ratios
    ? opt.ratios.map((r) => RATIOS.find(([k]) => k === r) ?? ([r as VideoAspect, ...ratioBox(r)] as [VideoAspect, number, number]))
    : RATIOS;

  const setRatio = (aspectRatio: VideoAspect) => {
    if (props.kind === 'video') props.onValueChange({ ...props.value, aspectRatio });
    else props.onValueChange({ ...props.value, aspectRatio });
  };

  let groups: React.ReactNode;
  let cost: number | null;
  let eta: string | undefined;
  if (props.kind === 'video') {
    const v = props.value;
    const off = { resolution: [], duration: ['30s' as const], count: [], ...props.unsupported };
    const set = (patch: Partial<VideoParams>) => props.onValueChange({ ...v, ...patch });
    const opts = <T extends string>(values: readonly T[], disabled: readonly T[] = []) =>
      values.map((value) => ({ value, label: value, disabled: disabled.includes(value), disabledReason: unsupported }));
    const durationNote = props.durationNote === undefined ? t('note.duration') : props.durationNote;
    const resolutions = shown(['480p', '720p', '1080p'] as const, opt.resolutions);
    const durations = shown(['5s', '10s', '15s', '30s'] as const, opt.durations);
    const counts = opt.counts === null ? [] : shown(['1', '2', '4'] as const, opt.counts);
    groups = (
      <>
        {resolutions.length ? (
          <Group label={t('resolution')}>
            <SegmentedControl className={styles.seg} label={t('resolution')} value={v.resolution} onValueChange={unlessLocked('video', (resolution: VideoParams['resolution']) => set({ resolution }))} options={withPlanLocks(opts(resolutions, off.resolution), 'video')} />
          </Group>
        ) : null}
        {durations.length ? (
          <Group label={t('duration')} note={durationNote}>
            <SegmentedControl className={styles.seg} label={t('duration')} value={v.duration} onValueChange={(duration) => set({ duration })} options={opts(durations, opt.durations ? [] : off.duration)} />
          </Group>
        ) : null}
        {counts.length > 1 ? (
          <Group label={t('count')} note={t('note.count')}>
            <SegmentedControl className={styles.seg} label={t('count')} value={v.count} onValueChange={(count) => set({ count })} options={opts(counts, off.count)} />
          </Group>
        ) : null}
        {props.audioSupported !== false ? (
          <div className={styles.audio}>
            <span className={styles.audioText}>
              <span className={styles.audioTitle}>{t('audio')}</span>
              <span className={styles.audioDesc}>{t('audio.desc')}</span>
            </span>
            <Switch checked={v.audio} onCheckedChange={(audio) => set({ audio })} aria-label={t('audio')} />
          </div>
        ) : null}
      </>
    );
    cost = props.cost !== undefined ? props.cost : isMockApi() ? mockData().overlays.estimateVideoCost(v) : null;
    eta = props.eta ?? (isMockApi() ? (parseInt(v.duration, 10) > 5 ? '3 min' : '2 min') : undefined);
  } else {
    const v = props.value;
    const off = { size: [], count: [], ...props.unsupported };
    const set = (patch: Partial<ImageParams>) => props.onValueChange({ ...v, ...patch });
    const sizes = shown(['1K', '2K', '4K'] as const, opt.resolutions);
    const counts = opt.counts === null ? [] : shown(['1', '2', '4'] as const, opt.counts);
    const quality = opt.quality !== false;
    groups = (
      <>
        {quality ? (
        <Group label={t('quality')}>
          <SegmentedControl
            className={styles.seg}
            label={t('quality')}
            value={v.quality}
            onValueChange={(quality) => set({ quality, size: quality === 'standard' && v.size === '4K' ? '2K' : v.size })}
            options={[
              { value: 'standard' as const, label: t('quality.standard') },
              { value: 'high' as const, label: t('quality.high') },
            ]}
          />
        </Group>
        ) : null}
        {sizes.length ? (
        <Group label={t('resolution')} note={!quality || (props.plan && planLockInfo(intl, props.plan, 'image', '4K')) ? null : t('note.size')}>
          <SegmentedControl
            className={styles.seg}
            label={t('resolution')}
            value={v.size}
            onValueChange={unlessLocked('image', (size: ImageParams['size']) => set({ size }))}
            options={withPlanLocks(
              sizes.map((value) => ({
                value,
                label: value,
                disabled: (quality && value === '4K' && v.quality === 'standard') || (off.size as string[]).includes(value),
                disabledReason: unsupported,
              })),
              'image',
            )}
          />
        </Group>
        ) : null}
        {counts.length > 1 ? (
        <Group label={t('images')}>
          <SegmentedControl className={styles.seg} label={t('images')} value={v.count} onValueChange={(count) => set({ count })} options={counts.map((value) => ({ value, label: value, disabled: (off.count as string[]).includes(value), disabledReason: unsupported }))} />
        </Group>
        ) : null}
      </>
    );
    cost = props.cost !== undefined ? props.cost : isMockApi() ? mockData().overlays.estimateImageCost(v) : null;
    eta = props.eta ?? (isMockApi() ? '15s' : undefined);
  }

  const reset = () => {
    if (props.onReset) return props.onReset();
    if (props.kind === 'video') props.onValueChange(defaultVideoParams);
    else props.onValueChange(defaultImageParams);
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t(`title.${props.kind}`)}
      {...presenceProps(presence.state)}
      className={cx('rl-pop', styles.panel, className)}
      style={{ ...style, ['--rl-pop-dir' as string]: placement === 'above' ? 1 : -1 }}
    >
      <div className={styles.titleRow}>
        <span className={styles.title}>{t(`title.${props.kind}`)}</span>
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'overlays.close' })} onClick={onClose}>
          <Svg name="close" size={16} />
        </button>
      </div>

      {ratioTiles.length ? (
      <div className={styles.group}>
        <span id={ratioLabelId} className={styles.label}>
          {t('aspectRatio')}
        </span>
        <div ref={ratioRef} role="radiogroup" aria-labelledby={ratioLabelId} className={styles.ratios}>
          <span className={styles.ratioThumb} style={ratioThumb} aria-hidden="true" />
          {ratioTiles.map(([label, w, h]) => {
            const on = props.value.aspectRatio === label;
            return (
              <button key={label} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={styles.ratio} onClick={() => setRatio(label)}>
                <span className={styles.ratioBox} style={{ width: w, height: h }} />
                {label === 'Auto' ? t('auto') : label}
              </button>
            );
          })}
        </div>
      </div>
      ) : null}

      {groups}

      <div className={styles.cost}>
        <span className={styles.dot} />
        <span className={styles.costText}>
          {cost === null ? (
            <Skeleton width={96} height={13} />
          ) : (
            <FormattedMessage id={eta ? 'overlays.params.cost' : 'overlays.params.costOnly'} values={{ cost, eta, b: (c) => <b className={styles.costNum}>{c}</b> }} />
          )}
        </span>
        <button type="button" className={styles.reset} onClick={reset}>
          {t('reset')}
        </button>
      </div>
    </div>
  );
}

function Group({ label, note, children }: { label: string; note?: string | null; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <span className={styles.groupHead}>
        <span>{label}</span>
        {note ? <span className={styles.note}>{note}</span> : null}
      </span>
      {children}
    </div>
  );
}
