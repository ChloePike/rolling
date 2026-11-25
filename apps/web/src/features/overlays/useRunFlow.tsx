import { PLANS } from '@rolling/core/pricing/config';
import { useToast } from '@rolling/ui';
import { useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { getPrefs } from '@/lib/prefs';
import { checkoutPlan, checkoutTopUp, getCredits, getSession, MockFlowError, startMockRun, useCredits, type MockRun } from '@/lib/session';
import { Paywall } from './Paywall';
import { RunConfirm } from './RunConfirm';
import type { RunRowKind } from './types';

/** One paid run a host asks for (a generation from a prompt box, a regenerate in the viewer, …). */
export interface RunRequest {
  /** Quoted credits for the run. */
  cost: number;
  kind: RunRowKind;
  /** Verb phrase for the confirm button and toasts, e.g. "Generate video". */
  actionLabel: string;
  /** Row detail in the confirm, e.g. "Seedance 2.5 · 9:16 · 720p · 5s". */
  meta: string;
  /** Confirm subtitle, e.g. "Auto → Seedance 2.5". */
  subtitle?: string;
  /** Typical wait, e.g. "~2 min". */
  eta?: string;
  /** Called when the mock job finishes. */
  onDone?: (run: MockRun) => void;
  /** Toast action after the run finishes (e.g. View opens the result viewer). */
  viewLabel?: string;
}

type Step = { kind: 'idle' } | { kind: 'join' } | { kind: 'credits' } | { kind: 'confirm' };

/**
 * The gate every paid run goes through (CLAUDE.md non-negotiables, D-006,
 * D-007): no plan → join paywall (checkout, then resume); not enough credits
 * → top-up paywall (checkout, then resume); at or over the "Confirm before
 * running" threshold → RunConfirm; otherwise run at once. Runs go through the
 * mock quote → hold → settle in lib/session and toast their outcome (a failure
 * says it was refunded and offers Retry).
 *
 * Render `element` once in the host; call `request(run)` from the send button.
 */
export function useRunFlow(): { request: (run: RunRequest) => void; element: ReactNode; running: boolean } {
  const intl = useIntl();
  const toast = useToast();
  const credits = useCredits();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(0);
  const pending = useRef<RunRequest | null>(null);
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);

  const go = (run: RunRequest) => {
    setStep({ kind: 'idle' });
    setRunning((n) => n + 1);
    toast.show({ message: t('overlays.run.started', { label: run.actionLabel, cost: run.cost }) });
    startMockRun(run.cost).then(
      (r) => {
        setRunning((n) => n - 1);
        run.onDone?.(r);
        toast.show({
          message: t('overlays.run.done', { label: run.actionLabel }),
          action: run.viewLabel && run.onDone ? { label: run.viewLabel, onAction: () => run.onDone?.(r) } : undefined,
        });
      },
      (e: unknown) => {
        setRunning((n) => n - 1);
        if (e instanceof MockFlowError && e.code === 'INSUFFICIENT_CREDITS') return advance(run);
        toast.show({
          message: t('overlays.run.failed', { label: run.actionLabel, cost: run.cost }),
          action: { label: t('overlays.run.retry'), onAction: () => advance(run) },
          duration: 0,
        });
      },
    );
  };

  /** Moves the run to its next gate, reading the live session, credits and threshold. */
  function advance(run: RunRequest) {
    pending.current = run;
    if (!getSession().isMember) return setStep({ kind: 'join' });
    if (getCredits().available < run.cost) return setStep({ kind: 'credits' });
    const threshold = getPrefs().confirmThreshold;
    if (threshold <= 0 || run.cost >= threshold) return setStep({ kind: 'confirm' });
    go(run);
  }

  const paymentFailed = () => toast.show({ message: t('overlays.run.paymentFailed') });
  const close = () => {
    setStep({ kind: 'idle' });
    pending.current = null;
  };
  const run = pending.current;

  const element = (
    <>
      <Paywall
        open={step.kind === 'join'}
        onOpenChange={(o) => !o && !busy && close()}
        variant="join"
        busy={busy}
        onContinue={(option) => {
          setBusy(true);
          checkoutPlan(option.id).then(
            (s) => {
              setBusy(false);
              const plan = s.planId ? PLANS[s.planId] : null;
              if (plan) toast.show({ message: t('overlays.run.planActive', { plan: plan.label, credits: plan.monthlyCredits }) });
              if (pending.current) advance(pending.current);
            },
            () => {
              setBusy(false);
              paymentFailed();
            },
          );
        }}
      />
      <Paywall
        open={step.kind === 'credits'}
        onOpenChange={(o) => !o && !busy && close()}
        variant="credits"
        runCost={run?.cost ?? 0}
        balance={credits.available}
        busy={busy}
        onContinue={(option) => {
          setBusy(true);
          checkoutTopUp(option.amountUsd ?? 0).then(
            (r) => {
              setBusy(false);
              toast.show({ message: t('overlays.run.toppedUp', { credits: r.credits }) });
              if (pending.current) advance(pending.current);
            },
            () => {
              setBusy(false);
              paymentFailed();
            },
          );
        }}
      />
      <RunConfirm
        open={step.kind === 'confirm'}
        onOpenChange={(o) => !o && close()}
        variant="single"
        rows={run ? [{ id: 'run_this', name: t('overlays.run.row'), meta: run.meta, kind: run.kind, state: 'run', cost: run.cost }] : []}
        balance={credits.available}
        eta={run?.eta ?? '~2 min'}
        subtitle={run?.subtitle}
        actionLabel={run?.actionLabel}
        onConfirm={() => run && go(run)}
      />
    </>
  );

  return { request: advance, element, running: running > 0 };
}
