import type { CSSProperties } from 'react';
import { modelIcon } from './index';
import styles from './ModelIcon.module.css';

export interface ModelIconProps {
  /** Gateway or public model id. */
  modelId: string;
  /** Icon box in px. Default 16. */
  size?: number;
  /** `mono` (default): the mark tinted with `currentColor`. `color`: the brand colors, falling back to mono. */
  variant?: 'mono' | 'color';
  /** Accessible name; omit when the model name is shown next to it (decorative). */
  label?: string;
  className?: string;
}

/**
 * A model's provider mark, or null when it has none (keep the letter tile).
 * Mono marks are drawn as a CSS mask filled with `currentColor`, so they follow
 * the text color in light and dark themes.
 */
export function ModelIcon({ modelId, size = 16, variant = 'mono', label, className }: ModelIconProps) {
  const icon = modelIcon(modelId);
  if (!icon) return null;
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  if (variant === 'color' && icon.colorSrc) {
    return <img src={icon.colorSrc} width={size} height={size} alt={label ?? ''} className={className} data-brand={icon.brand} draggable={false} />;
  }
  const style = { width: size, height: size, '--model-icon': `url("${icon.src}")` } as CSSProperties;
  return <span {...a11y} className={`${styles.mono} ${className ?? ''}`} style={style} data-brand={icon.brand} />;
}
