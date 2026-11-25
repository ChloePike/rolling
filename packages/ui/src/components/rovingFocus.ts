import type { KeyboardEvent } from 'react';

/**
 * Returns the index to move to for arrow/Home/End keys in a one-dimensional
 * composite widget (radio group, tab list), skipping disabled items.
 * Returns null when the key is not a navigation key.
 */
export function nextRovingIndex(
  e: KeyboardEvent,
  current: number,
  count: number,
  isDisabled: (i: number) => boolean,
): number | null {
  let step: number;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      step = 1;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      step = -1;
      break;
    case 'Home':
      return firstEnabled(0, 1, count, isDisabled);
    case 'End':
      return firstEnabled(count - 1, -1, count, isDisabled);
    default:
      return null;
  }
  for (let n = 1; n <= count; n++) {
    const i = (current + step * n + count) % count;
    if (!isDisabled(i)) return i;
  }
  return null;
}

function firstEnabled(start: number, step: number, count: number, isDisabled: (i: number) => boolean): number | null {
  for (let i = start; i >= 0 && i < count; i += step) if (!isDisabled(i)) return i;
  return null;
}
