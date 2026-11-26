import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PlanId } from '@rolling/core/pricing/config';
import { onPlanError, type PlanErrorEvent } from '@/lib/api/client';
import type { UpgradeReason } from './reasons';

/**
 * The one way into upgrading (owner request: locked clicks open a modal in
 * place, never a page). `openUpgrade(reason, { onResume, onDismiss })` opens
 * the shared UpgradeModal (mounted once in the root route); `onResume` runs
 * after the plan (or top-up) is active and the modal closes, e.g. to apply the
 * picked 1080p or send the kept brief. Actions that must survive a same-tab
 * Stripe redirect (popup blocked) also save a pending action (lib/session);
 * the modal emits the checkout resume so their hosts take it.
 */
export interface UpgradeOptions {
  /** The plan or top-up is active and the modal closed: continue what was interrupted. */
  onResume?: () => void;
  /** Closed without upgrading (Esc, Close, backdrop). The user's input stays untouched. */
  onDismiss?: () => void;
}

export interface UpgradeRequest extends UpgradeOptions {
  id: number;
  reason: UpgradeReason;
}

let current: UpgradeRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Opens the upgrade modal for `reason`. A request already open is replaced (its `onDismiss` runs). */
export function openUpgrade(reason: UpgradeReason, opts: UpgradeOptions = {}): number {
  const prev = current;
  current = { id: ++seq, reason, ...opts };
  emit();
  if (prev) prev.onDismiss?.();
  return current.id;
}

/**
 * Closes the modal. `resumed`: the upgrade went through (runs `onResume`),
 * otherwise `onDismiss`. `id` closes only that request.
 */
export function closeUpgrade(opts: { resumed?: boolean; id?: number; silent?: boolean } = {}): void {
  const req = current;
  if (!req || (opts.id !== undefined && opts.id !== req.id)) return;
  current = null;
  emit();
  if (opts.silent) return;
  if (opts.resumed) req.onResume?.();
  else req.onDismiss?.();
}

/** The open request, or null. */
export function getUpgrade(): UpgradeRequest | null {
  return current;
}

export function subscribeUpgrade(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUpgrade(): UpgradeRequest | null {
  return useSyncExternalStore(subscribeUpgrade, getUpgrade, getUpgrade);
}

/**
 * Declarative form for hosts that keep an `open` flag (the old join paywall
 * slots): opens the modal on the rising edge, closes it when `open` drops.
 * `onJoined` is the continuation after checkout; `onClose` runs on dismiss
 * and after `onJoined`, so the host can reset its flag.
 */
export function useUpgradeGate(open: boolean, reason: UpgradeReason, handlers: { onJoined?: () => void; onClose: () => void }): void {
  const ref = useRef({ reason, handlers });
  ref.current = { reason, handlers };
  useEffect(() => {
    if (!open) return;
    const id = openUpgrade(ref.current.reason, {
      onResume: () => {
        ref.current.handlers.onJoined?.();
        ref.current.handlers.onClose();
      },
      onDismiss: () => ref.current.handlers.onClose(),
    });
    // The host dropped `open` (or unmounted): close quietly, the host already knows.
    return () => closeUpgrade({ id, silent: true });
  }, [open]);
}

/** Component form of `useUpgradeGate` (renders nothing). */
export function UpgradeGate(props: { open: boolean; reason: UpgradeReason; onJoined?: () => void; onClose: () => void }): null {
  useUpgradeGate(props.open, props.reason, { onJoined: props.onJoined, onClose: props.onClose });
  return null;
}

/** The reason a plan error from the API stands for (shared API error handler). */
export function reasonFromPlanError(e: PlanErrorEvent): UpgradeReason {
  const data = (e.error.data ?? {}) as Record<string, unknown>;
  const path = e.path.replace(/\?.*$/, '');
  const body = (e.body ?? {}) as Record<string, unknown>;
  switch (e.error.code) {
    case 'RESOLUTION_LOCKED': {
      const value = typeof data.resolution === 'string' ? data.resolution : '1080p';
      return { kind: 'resolution', value, ...(data.kind === 'image' || data.kind === 'video' ? { media: data.kind } : {}) };
    }
    case 'TEAM_REQUIRED':
      return { kind: 'team-invite' };
    case 'PLAN_REQUIRED':
      return typeof data.plan === 'string' ? { kind: 'plan', plan: data.plan as PlanId } : { kind: 'plan' };
    default:
      if (path.startsWith('/api/agent')) return { kind: 'agent' };
      if (/\/prefs\b/.test(path) && 'matureContent' in body) return { kind: 'mature' };
      if (path.startsWith('/api/billing/auto-topup')) return { kind: 'auto-top-up' };
      if (path.startsWith('/api/billing/checkout')) return { kind: 'top-up' };
      if (path.startsWith('/api/billing/portal')) return { kind: 'plan' };
      if (path.startsWith('/api/workspace/invites')) return { kind: 'team-invite' };
      return { kind: 'generate' };
  }
}

/** Plan errors from any command open the modal (once a host renders it, see UpgradeHost). */
export function installPlanErrorHandler(): () => void {
  onPlanError((e) => {
    // A host that opened the modal for this reason already keeps its own callbacks.
    if (current) return;
    openUpgrade(reasonFromPlanError(e));
  });
  return () => onPlanError(null);
}
