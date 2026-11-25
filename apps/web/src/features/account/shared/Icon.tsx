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
} as const;
