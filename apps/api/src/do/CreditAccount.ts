import { DurableObject } from "cloudflare:workers";
import {
  AgentAllowanceLedger,
  CreditLedger,
  LedgerError,
  type AccountState,
  type AgentHoldInput,
  type AgentHoldResult,
  type AgentPeriodInput,
  type AgentReleaseResult,
  type AgentSettleResult,
  type AgentUsageResult,
  type AutoTopUpSettings,
  type Balance,
  type ExpireResult,
  type GrantPeriod,
  type GrantResult,
  type HoldInput,
  type HoldResult,
  type LedgerLine,
  type LedgerOutcome,
  type ListingModel,
  type PurchaseResult,
  type QuoteItemInput,
  type QuoteResult,
  type ReleaseResult,
  type SeatsResult,
  type SettleResult,
  reconcile,
} from "@rolling/core/credits";
import { newId } from "@rolling/core/ids";
import type { PlanId } from "@rolling/core/pricing/config";
import { creditsMigrations } from "@rolling/db/do/credits";
import { migrateDurableObject } from "@rolling/db/do/migrate";
import { SqlAgentAllowanceStore } from "./agentAllowanceStore";
import { SqlLedgerStore } from "./creditStore";

/** Lines per `ledger-mirror` message (well under the 128 KB message limit). */
const MIRROR_CHUNK = 50;
/** Retry delay for the mirror outbox when the queue send fails. */
const MIRROR_RETRY_MS = 30_000;
/** Idempotency records are kept this long (Stripe retries webhooks for 3 days). */
const IDEM_KEEP_MS = 35 * 86_400_000;

export interface LedgerMirrorBody {
  workspaceId: string;
  lines: LedgerLine[];
}

export interface AutoTopUpParams {
  kind: "autoTopUp";
  workspaceId: string;
  amountCents: number;
  window: string;
}

export interface AccountSummary {
  balance: Balance;
  planId: PlanId | null;
  interval: AccountState["interval"];
  periodStart: number | null;
  periodEnd: number | null;
  autoTopUp: AutoTopUpSettings | null;
  /** Purchased seats (Team, D-013; 1 otherwise). */
  seats: number;
  /** Plan the current slice's credits were granted for. */
  grantedPlanId: PlanId | null;
}

/**
 * One instance per workspace (`idFromName(workspaceId)`); the only place
 * balances change. Ledger rules live in `@rolling/core/credits`; this class
 * persists them in SQLite, mirrors every committed line to D1 through the
 * `ledger-mirror` queue (outbox: lines stay unmirrored until the send
 * succeeds), runs period-end expiry on an alarm, and starts `BillingWorkflow`
 * for auto top-ups.
 *
 * RPC methods return `LedgerOutcome` (errors as values: thrown errors lose
 * their code across RPC). `unwrapLedger` in `billing/credits.ts` turns them
 * into API errors.
 */
export class CreditAccount extends DurableObject<Env> {
  private schemaVersion = 0;
  private readonly store: SqlLedgerStore;
  private readonly ledger: CreditLedger;
  /** Agent allowance holds (D-012), serialized with the credit ledger. */
  private readonly agent: AgentAllowanceLedger;
  private lastAutoTopUpWindow: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlLedgerStore(ctx.storage);
    this.ledger = new CreditLedger(this.store, {
      now: () => Date.now(),
      newId: (kind) => newId(kind),
    });
    this.agent = new AgentAllowanceLedger(new SqlAgentAllowanceStore(ctx.storage), { now: () => Date.now() });
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrateDurableObject(ctx.storage, creditsMigrations);
      const name = ctx.id.name;
      if (name) this.store.setWorkspaceId(name);
    });
  }

  async ping(): Promise<{ ok: true; schemaVersion: number }> {
    return { ok: true, schemaVersion: this.schemaVersion };
  }

  // --- reads ---------------------------------------------------------------

  async balance(): Promise<Balance> {
    return this.ledger.balance();
  }

  async summary(): Promise<AccountSummary> {
    const s = this.ledger.account();
    return { balance: this.ledger.balance(), planId: s.planId, interval: s.interval, periodStart: s.periodStart, periodEnd: s.periodEnd, autoTopUp: s.autoTopUp, seats: s.seats, grantedPlanId: s.grantedPlanId };
  }

  /** Recomputes balances from the ledger (nightly reconcile, tests). */
  /**
   * Balance vs. the DO's own lines. With `before` (epoch ms), also the totals
   * and count of lines created before it, for the nightly reconcile against
   * the D1 mirror (lines newer than the cutoff may still be in the queue).
   */
  async audit(before?: number): Promise<{
    balance: Balance;
    fromLines: ReturnType<typeof reconcile>;
    ok: boolean;
    unmirrored: number;
    before?: { cutoff: number; lines: number; totals: ReturnType<typeof reconcile> };
  }> {
    const balance = this.ledger.balance();
    const all = this.store.allLines();
    const fromLines = reconcile(all);
    const ok = fromLines.plan === balance.plan && fromLines.purchased === balance.purchased && fromLines.held === balance.held;
    const out = { balance, fromLines, ok, unmirrored: this.store.unmirroredLines(10_000).length };
    if (before === undefined) return out;
    const older = all.filter((l) => l.createdAt < before);
    return { ...out, before: { cutoff: before, lines: older.length, totals: reconcile(older) } };
  }

  // --- ledger operations -----------------------------------------------------

  /** `catalog`: the synced listing models the items reference (`loadCatalog(env).models`). */
  async quote(items: QuoteItemInput[], catalog: ListingModel[]): Promise<LedgerOutcome<QuoteResult>> {
    return this.op(() => this.ledger.quote(items, catalog));
  }

  async hold(input: HoldInput): Promise<LedgerOutcome<HoldResult>> {
    return this.op(() => this.ledger.hold(input));
  }

  async settle(jobId: string, actual: number, idemKey: string): Promise<LedgerOutcome<SettleResult>> {
    return this.op(() => this.ledger.settle(jobId, actual, idemKey));
  }

  async release(jobId: string, reason: string, idemKey: string): Promise<LedgerOutcome<ReleaseResult>> {
    return this.op(() => this.ledger.release(jobId, reason, idemKey));
  }

  async grant(period: GrantPeriod, idemKey: string): Promise<LedgerOutcome<GrantResult>> {
    return this.op(() => this.ledger.grant(period, idemKey));
  }

  /** `credits` from `quoteTopUp`; `ref` is the Stripe PaymentIntent id. */
  async purchase(credits: number, ref: string, idemKey: string, source: "checkout" | "auto" = "checkout"): Promise<LedgerOutcome<PurchaseResult>> {
    return this.op(() => this.ledger.purchase(credits, ref, idemKey, source));
  }

  async expire(): Promise<LedgerOutcome<ExpireResult>> {
    return this.op(() => this.ledger.expire());
  }

  async cancelPlan(idemKey: string): Promise<LedgerOutcome<ExpireResult>> {
    return this.op(() => this.ledger.cancelPlan(idemKey));
  }

  async setPlan(planId: PlanId): Promise<LedgerOutcome<Balance>> {
    return this.op(() => this.ledger.setPlan(planId));
  }

  /** Team seats changed (Stripe quantity + 1): limits follow, added seats get prorated plan credits (D-013). */
  async setSeats(seats: number, idemKey: string): Promise<LedgerOutcome<SeatsResult>> {
    return this.op(() => this.ledger.setSeats(seats, idemKey));
  }

  async setAutoTopUp(settings: AutoTopUpSettings): Promise<LedgerOutcome<AutoTopUpSettings>> {
    return this.op(() => this.ledger.setAutoTopUp(settings));
  }

  // --- agent allowance (D-012) -----------------------------------------------

  /** Reserves a turn's estimate; AGENT_ALLOWANCE_EXHAUSTED when used + held + estimate > allowance. */
  async agentHold(input: AgentHoldInput): Promise<LedgerOutcome<AgentHoldResult>> {
    return this.op(() => this.agent.hold(input));
  }

  /** Charges a turn's actual LLM cost (may exceed the hold; the overrun is recorded). */
  async agentSettle(input: { turnId: string; actualUsd: number; idemKey: string }): Promise<LedgerOutcome<AgentSettleResult>> {
    return this.op(() => this.agent.settle(input));
  }

  /** Drops a hold without cost (cancel or failure before any LLM cost). */
  async agentRelease(input: { turnId: string; idemKey: string }): Promise<LedgerOutcome<AgentReleaseResult>> {
    return this.op(() => this.agent.release(input));
  }

  async agentUsage(input: AgentPeriodInput & { models?: { id: string; fallbackUsd: number }[] }): Promise<AgentUsageResult> {
    return this.agent.usage(input);
  }

  // --- after-commit effects --------------------------------------------------

  private async op<T>(fn: () => T): Promise<LedgerOutcome<T>> {
    let value: T;
    try {
      value = fn();
    } catch (e) {
      if (e instanceof LedgerError) return { ok: false, error: { code: e.code, message: e.message, data: e.data } };
      throw e;
    }
    await this.afterCommit();
    return { ok: true, value };
  }

  private workspaceId(): string {
    const id = this.store.getWorkspaceId() ?? this.ctx.id.name;
    if (!id) throw new Error("CreditAccount must be addressed with idFromName(workspaceId)");
    return id;
  }

  private async afterCommit(): Promise<void> {
    await this.flushMirror();
    await this.maybeAutoTopUp();
    await this.scheduleAlarm();
  }

  /** Sends unmirrored lines to the `ledger-mirror` queue; marks them on success. */
  private async flushMirror(): Promise<boolean> {
    const lines = this.store.unmirroredLines(500);
    if (lines.length === 0) return true;
    const workspaceId = this.workspaceId();
    try {
      const batch: { body: LedgerMirrorBody }[] = [];
      for (let i = 0; i < lines.length; i += MIRROR_CHUNK) batch.push({ body: { workspaceId, lines: lines.slice(i, i + MIRROR_CHUNK) } });
      await this.env.LEDGER_MIRROR_QUEUE.sendBatch(batch);
      this.store.markMirrored(lines.map((l) => l.id), Date.now());
      return true;
    } catch (e) {
      console.error(JSON.stringify({ msg: "ledger mirror send failed", workspaceId, lines: lines.length, error: String(e) }));
      return false;
    }
  }

  /**
   * Starts one `BillingWorkflow` per auto top-up window. The instance id is
   * derived from the window, so repeated triggers (every commit while below the
   * threshold) map to the same instance and are ignored.
   */
  private async maybeAutoTopUp(): Promise<void> {
    const due = this.ledger.autoTopUpDue();
    if (!due || due.window === this.lastAutoTopUpWindow) return;
    const workspaceId = this.workspaceId();
    const id = `atu-${workspaceId}-${due.window}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
    const params: AutoTopUpParams = { kind: "autoTopUp", workspaceId, amountCents: due.amountCents, window: due.window };
    try {
      await this.env.BILLING.create({ id, params });
    } catch (e) {
      // An instance with this id already exists: this window was handled.
      if (!/already exists|duplicate/i.test(String(e))) {
        console.error(JSON.stringify({ msg: "auto top-up start failed", workspaceId, error: String(e) }));
        return;
      }
    }
    this.lastAutoTopUpWindow = due.window;
  }

  private async scheduleAlarm(retryMirror = false): Promise<void> {
    const times: number[] = [];
    const exp = this.ledger.nextExpiry();
    if (exp !== null) times.push(exp);
    const stale = this.agent.nextStaleAt();
    if (stale !== null) times.push(stale);
    if (retryMirror || this.store.unmirroredLines(1).length > 0) times.push(Date.now() + MIRROR_RETRY_MS);
    if (times.length === 0) return;
    const at = Math.min(...times);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at || current < Date.now()) await this.ctx.storage.setAlarm(at);
  }

  /** Period end (expire plan credits, next yearly slice), stale agent holds, mirror retries, housekeeping. */
  override async alarm(): Promise<void> {
    this.ledger.expire();
    this.agent.expireStale();
    const sent = await this.flushMirror();
    await this.maybeAutoTopUp();
    this.store.purge(Date.now(), IDEM_KEEP_MS);
    await this.scheduleAlarm(!sent);
  }
}
