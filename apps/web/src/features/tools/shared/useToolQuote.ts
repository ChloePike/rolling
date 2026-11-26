import { useEffect, useRef, useState } from 'react';
import { isMockApi } from '@/lib/api/mode';
import { resolveAssetId } from '@/lib/transfers';
import { quoteSpec, resolveSpecAssets, type PromptSpec, type SpecQuote } from '@/features/overlays/runs';

/** What the composer and the settings popover show next to Generate. */
export interface ToolQuoteState {
  /** Credits from `POST /api/runs/quote`; null when there is no quote (inputs missing, refused, or not loaded yet). */
  credits: number | null;
  /** A quote request is in flight (a skeleton, never a guessed number). */
  loading: boolean;
  /** The last quote, so Generate can confirm or start it without asking again. */
  quote: SpecQuote | null;
}

const DEBOUNCE_MS = 350;

/**
 * Live quote for a tool's current request (real mode): the spec is quoted with
 * `POST /api/runs/quote { promptSpec }` a moment after it stops changing. A
 * spec that is a message (an input is missing) or null has no quote. The
 * number shown is always the server's total (D-006); nothing is estimated on
 * the client. Mock mode returns `mockCredits`, the mock adapter's estimate.
 */
export function useToolQuote(spec: PromptSpec | string | null, mockCredits?: number): ToolQuoteState {
  const mock = isMockApi();
  const key = mock || !spec || typeof spec === 'string' ? null : JSON.stringify(spec);
  const [state, setState] = useState<ToolQuoteState>({ credits: null, loading: false, quote: null });
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    if (!key) {
      setState({ credits: null, loading: false, quote: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const timer = window.setTimeout(() => {
      void resolveSpecAssets(JSON.parse(key) as PromptSpec, resolveAssetId)
        .then((resolved) => quoteSpec(resolved))
        .then(
          (q) => {
            if (id !== seq.current) return;
            const priced = q.items.filter((i) => i.action === 'run' || i.action === 'blocked').reduce((n, i) => n + i.credits, 0);
            const credits = q.quoteId ? q.total : priced > 0 ? priced : null;
            setState({ credits, loading: false, quote: q.quoteId ? q : null });
          },
          () => id === seq.current && setState({ credits: null, loading: false, quote: null }),
        );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
  if (mock) return { credits: mockCredits ?? null, loading: false, quote: null };
  return state;
}
