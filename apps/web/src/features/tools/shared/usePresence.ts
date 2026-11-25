import { useEffect, useState } from 'react';

export type PresenceState = 'enter' | 'exit';

/**
 * Keeps a layer mounted while its exit animation runs. `exitMs` should match
 * the CSS exit duration (exits are shorter than enters, handoff 7).
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: mounted || open, state: open ? 'enter' : 'exit' };
}
