import type { PlanId } from '@rolling/core/pricing/config';
import type { CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { PlanLock } from '@/features/overlays';
import layout from './ToolLayout.module.css';
import styles from './SettingsGroup.module.css';
import { ToolIcon, type ToolIconName } from './icons';

interface Base {
  id: string;
  title: string;
  icon: ToolIconName;
  hint?: string;
}

export interface SegOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Plan that unlocks this option (D-006); shown inside the locked option. */
  lockedBy?: PlanId;
  /** Tooltip for a disabled option. */
  reason?: string;
}

export type SettingsGroupDef =
  | (Base & {
      kind: 'seg';
      options: SegOption[];
      value: string;
      onChange: (v: string) => void;
      /** A plan-locked option was clicked (D-006): e.g. open the upgrade page. */
      onLocked?: (plan: PlanId) => void;
    })
  | (Base & {
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      value: number;
      display: string;
      low: string;
      high: string;
      onChange: (v: number) => void;
    })
  | (Base & {
      kind: 'input';
      value: string;
      placeholder: string;
      dice?: boolean;
      mono?: boolean;
      onChange: (v: string) => void;
      onRoll?: () => void;
    })
  | (Base & { kind: 'text'; value: string; placeholder: string; onChange: (v: string) => void })
  | (Base & {
      kind: 'shots';
      shots: Array<{ id: string; time: string; desc: string; fields: Array<{ label: string; state: 'open' | 'edit' | 'lock' }> }>;
    });

/** One card of the Advanced settings panel. */
export function SettingsGroup({ def, className, style }: { def: SettingsGroupDef; className?: string; style?: CSSProperties }) {
  const intl = useIntl();
  return (
    <div className={`${layout.card} ${className ?? ''}`} style={style} data-group={def.id}>
      <div className={styles.head}>
        <ToolIcon name={def.icon} size={14} />
        <h2 className={styles.title}>{def.title}</h2>
        <span className={layout.spacer} />
        {def.hint && <span className={styles.hint}>{def.hint}</span>}
      </div>
      {def.kind === 'seg' && (
        <div className={styles.segs}>
          {def.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={styles.seg}
              aria-pressed={def.value === o.value}
              // Plan-locked options stay clickable when the host offers the upgrade.
              disabled={o.disabled && !(o.lockedBy && def.onLocked)}
              title={o.disabled ? (o.reason ?? intl.formatMessage({ id: 'tools.adv.unavailable' })) : undefined}
              aria-label={o.lockedBy ? intl.formatMessage({ id: 'overlays.planLock.label' }, { option: o.label, reason: o.reason ?? '' }) : undefined}
              data-locked={o.lockedBy ? 'true' : undefined}
              onClick={() => (o.lockedBy ? def.onLocked?.(o.lockedBy) : def.onChange(o.value))}
            >
              {o.label}
              {o.lockedBy && <PlanLock plan={o.lockedBy} />}
            </button>
          ))}
        </div>
      )}
      {def.kind === 'slider' && (
        <>
          <div className={styles.sliderRow}>
            <input
              type="range"
              className={styles.range}
              aria-label={def.title}
              aria-valuetext={def.display}
              min={def.min}
              max={def.max}
              step={def.step}
              value={def.value}
              onChange={(e) => def.onChange(Number(e.target.value))}
            />
            <span className={styles.value}>{def.display}</span>
          </div>
          <div className={styles.ends}>
            <span>{def.low}</span>
            <span>{def.high}</span>
          </div>
        </>
      )}
      {def.kind === 'input' && (
        <div className={styles.inputRow}>
          <input
            aria-label={def.title}
            className={def.mono ? `${styles.input} ${styles.mono}` : styles.input}
            value={def.value}
            placeholder={def.placeholder}
            onChange={(e) => def.onChange(e.target.value)}
          />
          {def.dice && (
            <button
              type="button"
              className={styles.dice}
              aria-label={intl.formatMessage({ id: 'tools.adv.seed.random' })}
              title={intl.formatMessage({ id: 'tools.adv.seed.randomShort' })}
              onClick={def.onRoll}
            >
              <ToolIcon name="dice" size={15} />
            </button>
          )}
        </div>
      )}
      {def.kind === 'text' && (
        <textarea
          aria-label={def.title}
          rows={2}
          className={styles.text}
          value={def.value}
          placeholder={def.placeholder}
          onChange={(e) => def.onChange(e.target.value)}
        />
      )}
      {def.kind === 'shots' &&
        def.shots.map((s) => (
          <div key={s.id} className={styles.shot}>
            <div className={styles.shotHead}>
              <b>{s.id}</b>
              <span className={styles.shotT}>{s.time}</span>
              <span className={styles.shotDesc}>{s.desc}</span>
            </div>
            <div className={styles.fields}>
              {s.fields.map((f) => (
                <span
                  key={f.label}
                  className={`${styles.field} ${f.state === 'edit' ? styles.fieldEdit : f.state === 'lock' ? styles.fieldLock : ''}`}
                >
                  {f.label}
                </span>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
