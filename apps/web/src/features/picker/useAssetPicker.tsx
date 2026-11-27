import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { lazyComponent, preloadWhenIdle } from '@/lib/lazy';
import type { AssetPick, AssetPickerOptions } from './types';

/** The modal loads on demand (bundle splitting): fetched when idle after a page that can open it renders. */
const AssetPicker = lazyComponent(() => import('./AssetPicker'), (m) => m.AssetPicker);

interface Session {
  n: number;
  open: boolean;
  options: AssetPickerOptions;
}

/**
 * Opens the asset picker modal from any button:
 *
 *   const picker = useAssetPicker();
 *   …{picker.element}
 *   const picks = await picker.open({ title: 'Character', kinds: ['image'], categories: ['portrait'] });
 *   if (picks) use(picks[0].assetId);
 *
 * Resolves with the picks on "Use", `null` on Cancel / Esc. Each open starts
 * fresh (its own tab, filters and selection).
 */
export function useAssetPicker(): { open: (options?: AssetPickerOptions) => Promise<AssetPick[] | null>; element: ReactNode; isOpen: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const resolver = useRef<((v: AssetPick[] | null) => void) | null>(null);
  const counter = useRef(0);

  const finish = useCallback((v: AssetPick[] | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setSession((s) => (s ? { ...s, open: false } : s));
  }, []);

  const open = useCallback((options: AssetPickerOptions = {}) => {
    resolver.current?.(null);
    counter.current += 1;
    setSession({ n: counter.current, open: true, options });
    return new Promise<AssetPick[] | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const onClose = useCallback(() => finish(null), [finish]);
  const onConfirm = useCallback((picks: AssetPick[]) => finish(picks), [finish]);

  useEffect(() => preloadWhenIdle(AssetPicker), []);

  const element = session ? (
    <Suspense fallback={null}>
      <AssetPicker key={session.n} open={session.open} options={session.options} onClose={onClose} onConfirm={onConfirm} />
    </Suspense>
  ) : null;
  return { open, element, isOpen: !!session?.open };
}
