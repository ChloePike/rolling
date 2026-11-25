import type { SVGProps } from 'react';

/** Stroke icon paths (lucide-style, 24x24) copied from Main.dc.html and Templates.dc.html. */
export const promptIcons = {
  spark:
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z M20 3v4 M22 5h-4 M4 17v2 M5 18H3',
  image:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  video:
    'M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5 M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  person: 'M18 20a6 6 0 0 0-12 0 M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  cube: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7l8.7 5 8.7-5 M12 22V12',
  ratio: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
  wide: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M12 6v6l4 2',
  res: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8 21h8 M12 17v4',
  wave: 'M2 10v3 M6 6v11 M10 3v18 M14 8v7 M18 5v13 M22 10v3',
  frame:
    'M5 3h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 11v4a2 2 0 0 0 2 2h4 M15 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
  upload: 'M12 3v12 M17 8l-5-5-5 5 M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
  lib: 'M16 6l4 14 M12 6v14 M8 8v12 M4 4v16',
  at: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8',
  film: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 3v18 M3 7.5h4 M3 12h18 M3 16.5h4 M17 3v18 M17 7.5h4 M17 16.5h4',
  book: 'M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  bag: 'M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z M3 6h18 M16 10a4 4 0 0 1-8 0',
  brand:
    'M15.477 12.89l1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526 M12 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  copy: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  bolt: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  trash: 'M3 6h18 M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6 M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2',
  plus: 'M5 12h14 M12 5v14',
  close: 'M18 6 6 18 M6 6l12 12',
  coin: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8 M12 18V6',
  arrowUp: 'M5 12l7-7 7 7 M12 19V5',
  caret: 'm6 9 6 6 6-6',
  check: 'M20 6 9 17l-5-5',
  search: 'M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z M21 21l-4.3-4.3',
  // Reference card glyphs (Main.dc.html PK_IC).
  img: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  vid: 'm22 8-6 4 6 4V8z M2 6h14v12H2z',
  pose: 'M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M12 6v7 M8 9l4 1 4-3 M12 13l-3 8 M12 13l3 8',
  wear: 'M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z',
  face: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01',
  scene: 'M8 3l4 8 5-5 5 15H2L8 3z',
  light: 'M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
  hair: 'M4 20c0-9 3-16 8-16s8 7 8 16 M8 20c0-6 1.5-10 4-10s4 4 4 10',
  prop: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
  user: 'M18 20a6 6 0 0 0-12 0 M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  txt: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
} as const;

export type PromptIconName = keyof typeof promptIcons;

export interface PromptIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: PromptIconName;
  size?: number;
  strokeWidth?: number;
}

/** Stroke icon from {@link promptIcons}. Decorative (aria-hidden). */
export function PromptIcon({ name, size = 16, strokeWidth = 2, ...rest }: PromptIconProps) {
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
      <path d={promptIcons[name]} />
    </svg>
  );
}
