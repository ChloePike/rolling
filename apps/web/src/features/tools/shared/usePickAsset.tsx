import { useRef, type ReactNode } from 'react';
import { useAssetPicker, type AssetPick, type AssetPickerOptions } from '@/features/picker';

/**
 * The asset picker modal behind any button: render `element` once, call
 * `open()` from the button (optionally with per-call options, e.g. which slot
 * it is for). The chosen item is always an asset in the user's Assets: picked
 * from My assets, a Character or the public library, or uploaded from the
 * modal (straight to R2 through the shared queue, D-011). `onPick` gets it.
 */
export function usePickAsset(options: AssetPickerOptions, onPick: (pick: AssetPick, all: AssetPick[]) => void): { open: (override?: Partial<AssetPickerOptions>) => void; element: ReactNode } {
  const picker = useAssetPicker();
  const cb = useRef(onPick);
  cb.current = onPick;
  return {
    element: picker.element,
    open: (override) =>
      void picker.open({ ...options, ...override }).then((picks) => {
        if (picks?.[0]) cb.current(picks[0], picks);
      }),
  };
}
