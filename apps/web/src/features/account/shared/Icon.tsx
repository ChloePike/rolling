import type { SVGProps } from 'react';

interface PathIconProps extends Omit<SVGProps<SVGSVGElement>, 'd'> {
  /** One or more lucide-style path commands on a 24x24 grid, copied from the design files. */
  d: string;
  size?: number;
  strokeWidth?: number;
}

/** Stroke icon drawn from a design path. Decorative unless given an aria-label. */
export function PathIcon({ d, size = 16, strokeWidth = 2, ...rest }: PathIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export const paths = {
  search: 'M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z M21 21l-4.3-4.3',
  chevronDown: 'm6 9 6 6 6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  check: 'M20 6 9 17l-5-5',
  upload: 'M12 3v12 M17 8l-5-5-5 5 M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
  download: 'M12 15V3 M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5',
  plus: 'M5 12h14 M12 5v14',
  alert: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 8v4 M12 16h.01',
  copy: 'M8 8h12v12H8z M4 16V4h12',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  shuffle:
    'M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22 M18 2l4 4-4 4 M2 6h1.9c1.5 0 2.9.9 3.6 2.2 M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8 M18 14l4 4-4 4',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  minus: 'M5 12h14',
  x: 'M18 6 6 18 M6 6l12 12',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6',
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  pencil: 'M17 3l4 4L7 21H3v-4z',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h3v16H7z M14 4h3v16h-3z',
  external: 'M14 3h7v7 M10 14 21 3 M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
} as const;
