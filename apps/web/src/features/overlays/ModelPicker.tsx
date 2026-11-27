import { cx, presenceProps, Skeleton, staggerStyle, usePresence } from '@rolling/ui';
import { useId, useMemo, useRef, useState, type CSSProperties, type RefObject, useLayoutEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { FormattedMessage, useIntl } from 'react-intl';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import { Svg } from './icons';
import { useModels } from '@/lib/models';
import { catalogToOptions } from './catalog';
import styles from './ModelPicker.module.css';
import { AUTO_MODEL, type ModelKind, type ModelOption } from './types';
import { useDismiss } from './useDismiss';
import { PlanLock } from './PlanLock';
import { useSession } from '@/lib/session';
import { lowestPlanForModel, planRank } from '@/lib/upgrade/reasons';
import { openUpgrade } from '@/lib/upgrade/store';
import { PLANS, type PlanId } from '@rolling/core/pricing/config';

export interface ModelPickerProps {
  /** Catalog to show: video models, image models, or lip-sync methods. */
  kind: ModelKind;
  /** Selected model id, or `AUTO_MODEL` ("auto") for Auto. */
  value: string;
  /** Called with the picked model id (or "auto"). The picker does not close itself; close it in the handler if wanted. */
  onValueChange: (id: string) => void;
  /** Close button, Escape and (unless `dismissOnOutside` is false) pointer down outside. */
  onClose?: () => void;
  /** Visible state; the panel animates in and out (200ms in, 140ms out). Default true. */
  open?: boolean;
  /**
   * Models to list. Defaults to the synced catalog from `useModels()` (IndexedDB
   * cache first, then revalidated), mapped with `catalogToOptions`. Pass a list
   * to override it (tests, previews: `mockModels[kind]`).
   */
  models?: ModelOption[];
  /**
   * The list is still loading: skeleton rows instead of models and no "No models
   * match" note. Defaults to the synced catalog's state when `models` is not passed.
   */
  loading?: boolean;
  /** Include `matureOnly` catalog models (members with the mature preference on). */
  showMature?: boolean;
  /** Where the panel sits relative to its trigger; sets the entry direction. Default `above` (prompt-box pills). */
  placement?: 'above' | 'below';
  /** Trigger element, ignored by the outside-click dismissal so it can toggle. */
  anchorRef?: RefObject<HTMLElement | null>;
  dismissOnOutside?: boolean;
  /**
   * The workspace's plan for model locks (D-006): a model whose smallest
   * resolution is above the plan's cap shows the plan that unlocks it, and
   * picking it opens the upgrade modal (the model is selected once the plan is
   * active). Default: the session's plan; `null` shows no locks.
   */
  plan?: PlanId | null;
  /** "Compare all models ›" link target. */
  compareHref?: string;
  className?: string;
  /** Positioning from the host, e.g. absolute placement above the prompt box. */
  style?: CSSProperties;
}

/**
 * Model picker panel (ModelPicker.dc.html): search, the Auto option, the model
 * list with tags, price per 5s / per image and a disabled-with-reason state.
 * Rows enter with the list stagger (30ms apart, max 6).
 * Positioning is up to the host (the designs place it centered above the prompt box).
 */
export function ModelPicker({
  kind,
  value,
  onValueChange,
  onClose,
  open = true,
  models,
  loading: loadingProp,
  showMature = false,
  placement = 'above',
  anchorRef,
  dismissOnOutside = true,
  compareHref = '/upgrade',
  plan: planProp,
  className,
  style,
}: ModelPickerProps) {
  const intl = useIntl();
  const session = useSession();
  const plan = planProp === undefined ? session.planId : planProp;
  /** Plan that unlocks `m`, or null when the current plan (Starter for non-members) covers it. */
  const lockOf = (m: ModelOption): PlanId | null => {
    if (planProp === null || !m.resolutions?.length) return null;
    const need = lowestPlanForModel({ resolutions: m.resolutions, media: m.media });
    return planRank(need) > planRank(plan ?? 'starter') ? need : null;
  };
  const presence = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchId = useId();
  const [query, setQuery] = useState('');
  useDismiss(open, onClose, panelRef, anchorRef, dismissOnOutside);

  const catalog = useModels(kind === 'image' ? 'image' : 'video');
  const fromCatalog = useMemo(
    () => (catalog.data ? catalogToOptions(catalog.data, kind, { showMature }) : []),
    [catalog.data, kind, showMature],
  );
  const list = models ?? fromCatalog;
  const loading = (loadingProp ?? (models === undefined && catalog.data === undefined)) && list.length === 0;
  const [showMore, setShowMore] = useState(false);
  const moreCount = useMemo(() => list.filter((m) => m.more).length, [list]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A search covers every model; otherwise "More models" stay folded until asked for.
    if (!q) return showMore ? list : list.filter((m) => !m.more);
    return list.filter((m) => [m.name, ...m.tags].some((t) => t.toLowerCase().includes(q)));
  }, [list, query, showMore]);

  // Keep the panel inside the viewport: cap its height to the space on its side
  // of the anchor; the model list scrolls inside while search and footer stay put.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const margin = 16;
      const space = anchor
        ? placement === 'above'
          ? anchor.top - margin
          : window.innerHeight - anchor.bottom - margin
        : window.innerHeight - 2 * margin;
      setMaxHeight(Math.max(240, Math.min(space, 640)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, anchorRef, placement]);

  if (!presence.mounted) return null;
  const autoOn = value === AUTO_MODEL;

  const price = (m: ModelOption) =>
    m.unit === 'perMinute'
      ? intl.formatMessage({ id: 'overlays.modelPicker.price.perMinute' })
      : intl.formatMessage({ id: `overlays.modelPicker.price.${m.unit}` }, { credits: m.credits });

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={intl.formatMessage({ id: 'overlays.modelPicker.label' })}
      {...presenceProps(presence.state)}
      className={cx('rl-pop', styles.panel, className)}
      style={{ ...style, maxHeight, ['--rl-pop-dir' as string]: placement === 'above' ? 1 : -1 }}
    >
      <div className={styles.searchRow}>
        <label htmlFor={searchId} className={styles.search}>
          <Svg name="search" size={15} stroke="var(--c-text-4)" strokeLinejoin={undefined} />
          <input
            id={searchId}
            className={styles.input}
            placeholder={intl.formatMessage({ id: 'overlays.modelPicker.search' })}
            aria-label={intl.formatMessage({ id: 'overlays.modelPicker.searchLabel' })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'overlays.close' })} onClick={onClose}>
          <Svg name="close" size={16} />
        </button>
      </div>

      <div className={styles.scroll} data-testid="model-picker-scroll" aria-busy={loading || undefined}>
      <button
        type="button"
        aria-pressed={autoOn}
        className={cx('rl-stagger', styles.auto)}
        style={staggerStyle(0)}
        onClick={() => onValueChange(AUTO_MODEL)}
      >
        <span className={styles.autoIcon}>
          <Svg name="cube" size={18} stroke="var(--c-text-2)" />
        </span>
        <span className={styles.autoText}>
          <span className={styles.autoName}>
            <FormattedMessage id="overlays.modelPicker.auto" />{' '}
            <span className={styles.forYou}>
              <FormattedMessage id="overlays.modelPicker.auto.badge" />
            </span>
          </span>
          <span className={styles.autoDesc}>
            <FormattedMessage id="overlays.modelPicker.auto.desc" />
          </span>
        </span>
      </button>

      <div className={styles.group}>
        <FormattedMessage id={`overlays.modelPicker.group.${kind}`} />
      </div>
      {loading
        ? [0, 1, 2].map((i) => (
            <div key={i} className={styles.model} data-testid="model-picker-skeleton" aria-hidden="true">
              <Skeleton width={32} height={32} radius={8} />
              <span className={styles.body}>
                <Skeleton width={140} height={13} />
                <Skeleton width={180} height={11} />
              </span>
              <span className={styles.priceCol}>
                <Skeleton width={48} height={13} />
              </span>
            </div>
          ))
        : null}
      {filtered.map((m, i) => {
        const on = value === m.id;
        const lock = m.disabled ? null : lockOf(m);
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            disabled={m.disabled}
            title={m.disabled ? m.disabledReason : lock ? intl.formatMessage({ id: 'overlays.planLock.reason' }, { plan: PLANS[lock].label }) : undefined}
            data-locked={lock ? 'true' : undefined}
            className={cx('rl-stagger', styles.model)}
            style={staggerStyle(i + 1)}
            onClick={() => {
              if (m.disabled) return;
              // A locked model opens the upgrade modal in place; it is selected once the plan is active.
              if (lock) return void openUpgrade({ kind: 'model', id: m.id, name: m.name, plan: lock }, { onResume: () => onValueChange(m.id) });
              onValueChange(m.id);
            }}
          >
            {modelIcon(m.id) ? (
              <span className={cx(styles.mark, styles.markIcon)} data-model-icon={modelIcon(m.id)!.brand}>
                <ModelIcon modelId={m.id} size={18} />
              </span>
            ) : (
              <span className={styles.mark} style={{ background: m.tone }}>
                {m.mark}
              </span>
            )}
            <span className={styles.body}>
              <span className={styles.nameRow}>
                <span className={styles.name}>{m.name}</span>
                {lock ? <PlanLock plan={lock} /> : null}
                {m.badge ? (
                  <span className={cx(styles.badge, styles[`badge_${m.badge}`])}>
                    <FormattedMessage id={`overlays.modelPicker.badge.${m.badge}`} />
                  </span>
                ) : null}
              </span>
              <span className={styles.tags}>
                {m.tags.map((t) => (
                  <span key={t} className={styles.tag}>
                    {t}
                  </span>
                ))}
              </span>
            </span>
            <span className={styles.priceCol}>
              <span className={styles.price}>{price(m)}</span>
              <span className={styles.eta}>{m.eta}</span>
            </span>
            <span className={styles.check}>{on ? <Svg name="check" size={16} strokeWidth={2.6} /> : null}</span>
          </button>
        );
      })}
      {filtered.length === 0 && !loading ? (
        <div className={styles.empty}>
          <FormattedMessage id="overlays.modelPicker.empty" values={{ query: query.trim() }} />
        </div>
      ) : null}
        {!query.trim() && moreCount > 0 ? (
          <button type="button" className={styles.more} aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
            <FormattedMessage id={showMore ? 'overlays.modelPicker.fewer' : 'overlays.modelPicker.more'} values={{ count: moreCount }} />
          </button>
        ) : null}
      </div>
      <div className={styles.footer}>
        <span className={styles.footerText}>
          <FormattedMessage id="overlays.modelPicker.footer" />
        </span>
        <Link to={compareHref as never} className={styles.compare} onClick={() => onClose?.()}>
          <FormattedMessage id="overlays.modelPicker.compare" />
        </Link>
      </div>
    </div>
  );
}
