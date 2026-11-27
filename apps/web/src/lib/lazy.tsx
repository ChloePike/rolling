import { Suspense, use, useEffect, useState, type ComponentType, type JSX } from 'react';
import { loadEnglishRest } from '@/i18n/messages';

/**
 * Code splitting for on-demand layers (bundle splitting, 2026-11-27): popovers,
 * dialogs and pickers that a page shows only after a click stay out of the
 * page's first-load JS.
 *
 *   const AccountMenu = lazyComponent(() => import('./AccountMenu'), (m) => m.AccountMenuContent);
 *   …<Suspense fallback={null}><AccountMenu … /></Suspense>
 *   AccountMenu.preload() // on hover / focus of the trigger, or preloadWhenIdle(AccountMenu)
 *
 * `preload()` is idempotent and never rejects; a failed chunk load is retried by
 * the next preload or render (a render that fails shows the route's error state).
 */
export type PreloadableComponent<P> = ComponentType<P> & { preload: () => Promise<void> };

/**
 * Like `React.lazy`, but once the chunk is in (preloaded or rendered before) it
 * renders synchronously: the first open after a preload never suspends, so a
 * layer's enter animation plays with its content.
 */
export function lazyComponent<M, P>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>): PreloadableComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () => {
    // With the rest of English (i18n/messages.ts): a layer may use any feature's messages.
    pending ??= Promise.all([load(), loadEnglishRest().catch(() => undefined)]).then(
      ([m]) => (loaded = pick(m)),
      (e: unknown) => {
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  function Lazy(props: P & JSX.IntrinsicAttributes) {
    const Component = loaded ?? use(get());
    return <Component {...props} />;
  }
  return Object.assign(Lazy as ComponentType<P>, {
    preload: () =>
      get().then(
        () => undefined,
        () => undefined,
      ),
  });
}

/** Fetches these chunks once the browser is idle (after the first render); returns a cancel function. */
export function preloadWhenIdle(...components: Array<{ preload: () => Promise<void> }>): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const run = () => {
    for (const c of components) void c.preload();
  };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

/**
 * A lazily loaded layer (dialog, popover panel) that stays out of the host's chunk:
 * nothing renders until it is first open, then it stays mounted so it can animate
 * out. Its chunk is fetched when the browser is idle after the host renders, so the
 * first open rarely waits; if it does, the layer appears when the chunk arrives.
 */
export function lazyLayer<M, P extends object>(
  load: () => Promise<M>,
  pick: (m: M) => ComponentType<P>,
  isOpen: (props: P) => boolean = (props) => !!(props as { open?: unknown }).open,
): ComponentType<P> & { preload: () => Promise<void> } {
  const Component = lazyComponent(load, pick);
  const preload = Component.preload;
  function LazyLayer(props: P) {
    const open = isOpen(props);
    const [mounted, setMounted] = useState(open);
    if (open && !mounted) setMounted(true);
    useEffect(() => preloadWhenIdle({ preload }), []);
    return mounted ? (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    ) : null;
  }
  return Object.assign(LazyLayer, { preload });
}
