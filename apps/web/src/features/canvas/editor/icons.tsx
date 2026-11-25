/** Stroke icons used by the editor, paths copied from CanvasEdit.dc.html. */
export const ICON = {
  back: 'M15 18l-6-6 6-6',
  undo: 'M3 7v6h6 M21 17a9 9 0 0 0-15-6.7L3 13',
  redo: 'M21 7v6h-6 M3 17a9 9 0 0 1 15-6.7L21 13',
  chevronDown: 'm6 9 6 6 6-6',
  export: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  video: 'm22 8-6 4 6 4V8z M2 6h14v12H2z',
  audio: 'M9 18V5l12-2v13 M6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6z M18 13a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  markIn: 'M7 4v16 M17 8l-4 4 4 4',
  prevEdit: 'M19 20 9 12l10-8z M5 19V5',
  play: 'M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z',
  pause: 'M7 4h3v16H7z M14 4h3v16h-3z',
  nextEdit: 'M5 4l10 8-10 8z M19 5v14',
  markOut: 'M17 4v16 M7 8l4 4-4 4',
  select: 'M4 4l7.07 17 2.51-7.39L21 11.07z',
  razor: 'M6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z M6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6z M20 4 8.12 15.88 M14.47 14.48 20 20 M8.12 8.12 12 12',
  slip: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3 M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3 M9 12h6 M12 9l3 3-3 3',
  text: 'M4 7V4h16v3 M9 20h6 M12 4v16',
  hand: 'M18 11V6a2 2 0 0 0-4 0 M14 10V4a2 2 0 0 0-4 0v2 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  snapping: 'm6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15 M5 8l4 4 M12 15l4 4',
  marker: 'M12 2l4 6-4 14-4-14z',
  effects: 'M10 20 14 4 M5 8h6 M13 16h6',
  send: 'M5 12l7-7 7 7 M12 19V5',
  zoomOut: 'M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z M21 21l-4.3-4.3 M8 11h6',
  zoomIn: 'M11 3a8 8 0 1 1 0 16 8 8 0 0 1 0-16z M21 21l-4.3-4.3 M11 8v6 M8 11h6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  eyeOff: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M3 3l18 18',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  mute: 'M11 5 6 9H2v6h4l5 4V5z M23 9l-6 6 M17 9l6 6',
} as const;

export type IconName = keyof typeof ICON;

export function Icon({ name, size = 16, stroke = 2 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON[name]} />
    </svg>
  );
}
