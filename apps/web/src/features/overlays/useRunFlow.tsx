import { useToast } from '@rolling/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { getPrefs } from '@/lib/prefs';
import { noteFinishedVideo } from '@/lib/pwa/install';
import { checkoutTopUp, getCredits, getSession, MockFlowError, onCheckoutResume, savePendingAction, startMockRun, takePendingAction, useCredits, type MockRun } from '@/lib/session';
import { Paywall } from './Paywall';
import { openUpgrade } from '@/lib/upgrade/store';
import { RunConfirm } from './RunConfirm';
import type { RunRowKind } from './types';
import { isApiError, isMockApi, userEvents } from './backend';
import { findRun, quoteSpec, runFinished, startQuote, type PromptSpec, type RunView, type SpecQuote } from './runs';
import { resolveAssetId } from '@/lib/transfers';

/** What a finished run hands back: the mock run, or the real run with its first result asset. */
export type FinishedRun = MockRun & { assetId?: string | null; run?: RunView };

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
  /** Called when the job finishes (real mode: with the result asset). */
  onDone?: (run: FinishedRun) => void;
  /**
   * Real mode: what to generate (`POST /api/runs/quote { promptSpec }`). The
   * quote replaces `cost`; input asset refs may be upload ids (`upl_…`), they
   * are resolved first. Without a spec the run cannot start in real mode.
   */
  spec?: PromptSpec;
  /**
   * Real mode, instead of `spec`: how to quote the run (e.g. a canvas node,
   * `POST /api/runs/quote { projectId, scope: 'node', nodeIds }`).
   */
  quote?: () => Promise<SpecQuote>;
  /** The run started (credits held). Real mode: the run id; mock mode: the mock run id. */
  onStarted?: (runId: string, credits: number) => void;
  /**
   * The host shows the run inline (Home run cards): no started/done toasts and, in real mode, the flow
   * does not follow the run (the host does, from `onStarted`). A failure toast with Retry stays (handoff 4).
   */
  inline?: boolean;
  /** The request ended without starting a run: the confirm or a paywall was dismissed, or the run could not start. */
  onAbort?: () => void;
  /** Real mode: the run failed or was canceled (credits refunded), or could not start. */
  onFailed?: () => void;
  /** Real mode: the project the run belongs to (Activity groups by it). */
  projectId?: string;
  /** Toast action after the run finishes (e.g. View opens the result viewer). */
  viewLabel?: string;
  /**
   * Survives the Stripe redirect: when a paywall interrupts this run, `data`
   * is kept with `savePendingAction(kind, data)`; the host takes it back in
   * `useCheckoutResume` and requests the run again (D-007).
   */
  resume?: { kind: string; data: unknown };
}

type Step = { kind: 'idle' } | { kind: 'join' } | { kind: 'credits' } | { kind: 'confirm' };

async function resolveSpec(spec: PromptSpec): Promise<PromptSpec> {
  const i = spec.inputs;
  if (!i) return spec;
  const one = async (id?: string) => (id ? resolveAssetId(id) : undefined);
  const many = async (ids?: string[]) => (ids ? Promise.all(ids.map((id) => resolveAssetId(id))) : undefined);
  const inputs = {
    ...(i.firstFrameAssetId ? { firstFrameAssetId: await one(i.firstFrameAssetId) } : {}),
    ...(i.lastFrameAssetId ? { lastFrameAssetId: await one(i.lastFrameAssetId) } : {}),
    ...(i.referenceAssetIds ? { referenceAssetIds: await many(i.referenceAssetIds) } : {}),
    ...(i.inputAssetIds ? { inputAssetIds: await many(i.inputAssetIds) } : {}),
    ...(i.audioAssetId ? { audioAssetId: await one(i.audioAssetId) } : {}),
  };
  return { ...spec, inputs };
}

/** Waits for a real run to finish: `activity.updated` on the user channel, with a polling fallback. */
function waitForRun(runId: string, projectId?: string): Promise<RunView> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (done) return;
      findRun(runId, projectId ? { projectId } : {}).then(
        (r) => {
          if (done || !r || !runFinished(r)) return;
          done = true;
          off();
          if (timer) clearTimeout(timer);
          resolve(r);
        },
        () => {},
      );
    };
    const off = userEvents((msg) => {
      if (msg.type === 'activity.updated' && (msg.payload as { runId?: string })?.runId === runId) check();
    });
    let delay = 3000;
    const poll = () => {
      check();
      if (done) return;
      delay = Math.min(15_000, delay * 1.3);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    // Give up waiting after 30 minutes; the result stays in Activity.
    setTimeout(() => {
      if (done) return;
      done = true;
      off();
      if (timer) clearTimeout(timer);
      reject(new Error('timeout'));
    }, 30 * 60_000);
  });
}

/**
 * The gate every paid run goes through (CLAUDE.md non-negotiables, D-006,
 * D-007): no plan → the shared upgrade modal (checkout, then resume); not enough credits
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

  /** A paywall opens for `run`: keep it for after the checkout (also across the Stripe redirect). */
  const toPaywall = (run: RunRequest, given: 'join' | 'credits') => {
    // D-007: without a plan the answer is always a plan first, never a top-up (non-members cannot buy credits).
    const kind = given === 'credits' && getSession().status === 'signedIn' && !getSession().isMember ? 'join' : given;
    if (run.resume) savePendingAction(run.resume.kind, run.resume.data);
    if (kind === 'credits') return setStep({ kind });
    // No plan: the shared upgrade modal. Its checkout resume continues the run (`onCheckoutResume` below).
    setStep({ kind: 'idle' });
    openUpgrade(
      { kind: 'generate' },
      {
        onDismiss: () => {
          pending.current?.onAbort?.();
          pending.current = null;
        },
      },
    );
  };
  /** The checkout finished in this tab: the run continues here, so its stored copy is dropped. */
  const continueAfterCheckout = () => {
    const run = pending.current;
    if (!run) return;
    if (run.resume) takePendingAction(run.resume.kind);
    advance(run);
  };

  const quoteRef = useRef<SpecQuote | null>(null);
  const [quoteTotal, setQuoteTotal] = useState<number | null>(null);
  const [quoteBalance, setQuoteBalance] = useState<number | null>(null);

  const failed = (run: RunRequest, refunded: number) =>
    toast.show({
      message: t('overlays.run.failed', { label: run.actionLabel, cost: refunded }),
      action: { label: t('overlays.run.retry'), onAction: () => advance(run) },
      duration: 0,
    });

  /** Real mode: `POST /api/runs { quoteId }`, then follow the run to its end. */
  const goReal = (run: RunRequest, quote: SpecQuote, attempt = 0) => {
    setStep({ kind: 'idle' });
    quoteRef.current = null;
    startQuote(quote.quoteId!).then(
      ({ runId }) => {
        run.onStarted?.(runId, quote.total);
        if (run.inline) return;
        setRunning((n) => n + 1);
        toast.show({ message: t('overlays.run.started', { label: run.actionLabel, cost: quote.total }) });
        waitForRun(runId, run.projectId).then(
          (r) => {
            setRunning((n) => n - 1);
            if (r.status === 'failed' || r.status === 'canceled') {
              run.onFailed?.();
              return failed(run, r.refunded);
            }
            const assetId = r.items.find((i) => i.assetId)?.assetId ?? null;
            const finished: FinishedRun = { id: runId, cost: r.spent, assetId, run: r };
            run.onDone?.(finished);
            if (r.items.some((i) => i.kind === 'video' && i.status === 'succeeded')) noteFinishedVideo();
            toast.show({
              message: t('overlays.run.done', { label: run.actionLabel }),
              action: run.viewLabel && run.onDone ? { label: run.viewLabel, onAction: () => run.onDone?.(finished) } : undefined,
            });
          },
          () => {
            setRunning((n) => n - 1);
            run.onFailed?.();
          },
        );
      },
      (e: unknown) => {
        run.onFailed?.();
        if (!isApiError(e, 'NO_PLAN') && !isApiError(e, 'INSUFFICIENT_CREDITS') && !(isApiError(e, 'QUOTE_EXPIRED') && attempt < 1)) run.onAbort?.();
        if (isApiError(e, 'NO_PLAN')) return toPaywall(run, 'join');
        if (isApiError(e, 'INSUFFICIENT_CREDITS')) return toPaywall(run, 'credits');
        if (isApiError(e, 'QUOTE_EXPIRED') && attempt < 1) return void advance(run, attempt + 1);
        if (isApiError(e, 'MEMBER_LIMIT_REACHED')) return void toast.show({ message: t('overlays.run.memberLimit'), duration: 0 });
        if (isApiError(e, 'CONCURRENCY_LIMIT')) return void toast.show({ message: t('overlays.run.concurrency', { limit: (e.data as { limit?: number }).limit ?? 0 }) });
        toast.show({ message: t('overlays.run.startFailed', { label: run.actionLabel }), action: { label: t('overlays.run.retry'), onAction: () => advance(run) } });
      },
    );
  };

  /** Real mode: quote the spec, show blocks, then gate like the mock flow (the API answers NO_PLAN itself). */
  const advanceReal = (run: RunRequest, attempt = 0) => {
    pending.current = run;
    const spec = run.spec;
    const getQuote = run.quote ?? (spec ? () => resolveSpec(spec).then((s) => quoteSpec(s, run.projectId)) : null);
    if (!getQuote) {
      run.onAbort?.();
      toast.show({ message: t('overlays.run.unavailable') });
      return;
    }
    void getQuote()
      .then(
        (q) => {
          quoteRef.current = q;
          setQuoteTotal(q.total);
          setQuoteBalance(q.balance);
          const blocked = q.items.find((i) => i.action === 'blocked');
          if (!q.quoteId) {
            if (blocked?.code === 'NO_PLAN') return toPaywall(run, 'join');
            run.onAbort?.();
            // D-005: mature content needs a paid plan → the upgrade modal with reason `mature` (members get the Settings copy).
            if (blocked?.code === 'MATURE_REQUIRED' && blocked.matureAccess === 'no_plan') return void openUpgrade({ kind: 'mature' });
            return void toast.show({ message: blocked?.reason ?? t('overlays.run.unavailable') });
          }
          if (q.balance < q.total) return toPaywall(run, 'credits');
          if (q.needsConfirm) return setStep({ kind: 'confirm' });
          goReal(run, q, attempt);
        },
        (e: unknown) => {
          if (isApiError(e, 'NO_PLAN')) return toPaywall(run, 'join');
          run.onAbort?.();
          toast.show({ message: t('overlays.run.startFailed', { label: run.actionLabel }) });
        },
      );
  };

  const go = (run: RunRequest) => {
    if (!isMockApi()) {
      const q = quoteRef.current;
      return q?.quoteId ? goReal(run, q) : advanceReal(run);
    }
    setStep({ kind: 'idle' });
    setRunning((n) => n + 1);
    if (!run.inline) toast.show({ message: t('overlays.run.started', { label: run.actionLabel, cost: run.cost }) });
    const mockId = `run_mock${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    run.onStarted?.(mockId, run.cost);
    startMockRun(run.cost).then(
      (r) => {
        setRunning((n) => n - 1);
        run.onDone?.({ ...r, id: run.inline ? mockId : r.id });
        if (run.kind === 'video') noteFinishedVideo();
        if (run.inline) return;
        toast.show({
          message: t('overlays.run.done', { label: run.actionLabel }),
          action: run.viewLabel && run.onDone ? { label: run.viewLabel, onAction: () => run.onDone?.(r) } : undefined,
        });
      },
      (e: unknown) => {
        setRunning((n) => n - 1);
        if (e instanceof MockFlowError && e.code === 'INSUFFICIENT_CREDITS') {
          run.onAbort?.();
          return advance(run);
        }
        run.onFailed?.();
        // Inline runs: the host's card says it failed and was refunded (and toasts Retry itself).
        if (run.inline) return;
        toast.show({
          message: t('overlays.run.failed', { label: run.actionLabel, cost: run.cost }),
          action: { label: t('overlays.run.retry'), onAction: () => advance(run) },
          duration: 0,
        });
      },
    );
  };

  /** Moves the run to its next gate, reading the live session, credits and threshold. */
  function advance(run: RunRequest, attempt = 0) {
    if (!isMockApi()) return advanceReal(run, attempt);
    pending.current = run;
    if (!getSession().isMember) return toPaywall(run, 'join');
    if (getCredits().available < run.cost) return toPaywall(run, 'credits');
    const threshold = getPrefs().confirmThreshold;
    if (threshold <= 0 || run.cost >= threshold) return setStep({ kind: 'confirm' });
    go(run);
  }

  const paymentFailed = () => toast.show({ message: t('overlays.run.paymentFailed') });
  const close = () => {
    setStep({ kind: 'idle' });
    pending.current?.onAbort?.();
    pending.current = null;
  };
  const run = pending.current;
  const real = !isMockApi();
  const shownCost = real && quoteTotal !== null ? quoteTotal : (run?.cost ?? 0);
  const shownBalance = real && quoteBalance !== null ? quoteBalance : credits.available;

  // After a checkout in this tab (or the Stripe redirect landing back here), the interrupted run continues.
  useEffect(
    () =>
      onCheckoutResume(() => continueAfterCheckout()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const element = (
    <>
      <Paywall
        open={step.kind === 'credits'}
        onOpenChange={(o) => !o && !busy && close()}
        variant="credits"
        runCost={shownCost}
        balance={shownBalance}
        busy={busy}
        onContinue={(option) => {
          setBusy(true);
          checkoutTopUp(option.amountUsd ?? 0).then(
            (r) => {
              setBusy(false);
              toast.show({ message: t('overlays.run.toppedUp', { credits: r.credits }) });
              continueAfterCheckout();
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
        rows={run ? [{ id: 'run_this', name: t('overlays.run.row'), meta: run.meta, kind: run.kind, state: 'run', cost: shownCost }] : []}
        balance={shownBalance}
        eta={run?.eta ?? '~2 min'}
        subtitle={run?.subtitle}
        actionLabel={run?.actionLabel}
        onConfirm={() => run && go(run)}
      />
    </>
  );

  return { request: advance, element, running: running > 0 };
}
