import { createElement, isValidElement, type ComponentType, type ReactNode } from 'react';
import styles from './Upgrade.parts.module.css';

/**
 * Model logos come from `modelIcon` in `src/lib/modelIcons` (owned by the
 * overlays/shell work). The module is loaded optionally so this page builds
 * before it lands; until then each model shows its letter mark.
 */
type IconResult = ReactNode | string | ComponentType<{ size?: number }> | null | undefined;
type ModelIconFn = (id: string, opts?: { size?: number }) => IconResult;

const modules = import.meta.glob<{ modelIcon?: ModelIconFn }>(['@/lib/modelIcons.ts', '@/lib/modelIcons.tsx', '@/lib/modelIcons/index.ts', '@/lib/modelIcons/index.tsx'], {
  eager: true,
});
const modelIcon: ModelIconFn | undefined = Object.values(modules).find((m) => typeof m.modelIcon === 'function')?.modelIcon;

function letters(name: string): string {
  const words = name.split(/[\s.-]+/).filter((w) => w && !/^\d/.test(w));
  return (words.map((w) => w[0]!.toUpperCase()).join('') || name.slice(0, 2)).slice(0, 2);
}

function render(icon: IconResult, size: number): ReactNode {
  if (icon === null || icon === undefined || icon === false) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'string') return /^(https?:|\/|data:)/.test(icon) ? <img src={icon} alt="" width={size} height={size} /> : null;
  if (typeof icon === 'function') return createElement(icon as ComponentType<{ size?: number }>, { size });
  return null;
}

export function ModelMark({ id, name, size = 18 }: { id: string; name: string; size?: number }) {
  let icon: ReactNode = null;
  try {
    icon = modelIcon ? render(modelIcon(id, { size }), size) : null;
  } catch {
    icon = null;
  }
  return (
    <span className={styles.mark} aria-hidden="true" data-has-logo={icon ? 'true' : 'false'}>
      {icon ?? letters(name)}
    </span>
  );
}
