import { tween, usePrefersReducedMotion } from '@rolling/ui';
import { LayoutGroup, motion as m } from 'motion/react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  /** `tablist` for views (period, profile tabs), `radiogroup` for settings. */
  kind?: 'tablist' | 'radiogroup';
  className: string | undefined;
  optionClassName: string | undefined;
  /** The selected marker (fill or underline); slides between options. */
  indicatorClassName: string | undefined;
}

/**
 * Single choice with a sliding selection marker (200ms, standard curve: `tween`
 * from the motion tokens). Arrow keys move the selection. Reduced motion: the
 * marker jumps.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  kind = 'radiogroup',
  className,
  optionClassName,
  indicatorClassName,
}: SegmentedProps<T>) {
  const group = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduced = usePrefersReducedMotion();
  const itemRole = kind === 'tablist' ? 'tab' : 'radio';

  function onKeyDown(e: KeyboardEvent, i: number) {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <LayoutGroup id={group}>
      <div role={kind} aria-label={label} className={className}>
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role={itemRole}
              aria-selected={kind === 'tablist' ? on : undefined}
              aria-checked={kind === 'radiogroup' ? on : undefined}
              tabIndex={on ? 0 : -1}
              className={optionClassName}
              style={{ position: 'relative', isolation: 'isolate' }}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {on && (
                <m.span
                  layoutId="indicator"
                  className={indicatorClassName}
                  transition={tween('base', 'standard', reduced)}
                  style={{ position: 'absolute', zIndex: -1 }}
                  aria-hidden="true"
                />
              )}
              {o.label}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
