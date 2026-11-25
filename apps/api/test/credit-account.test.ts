import { createMessageBatch, createExecutionContext, env, getQueueResult, introspectWorkflow, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LedgerLine, LedgerOutcome } from "@rolling/core/credits";
import { fixtureCatalog } from "@rolling/core/models/__fixtures__/catalog";
import worker from "../src/index";
import { lineFromRow } from "../src/do/creditStore";

const DAY = 86_400_000;
const catalog = fixtureCatalog.models.filter((m) => ["bytedance/seedance-2.5", "bytedance/seedream-5.0-lite"].includes(m.id));
const video = (ref: string, resolution = "720p") => ({ ref, modelId: "bytedance/seedance-2.5", request: { resolution, seconds: 5 } });
const image = (ref: string) => ({ ref, modelId: "bytedance/seedream-5.0-lite", request: { n: 1 } });

let seq = 0;
function account(name = `ws_test_${++seq}_${Date.now()}`) {
  return { name, stub: env.CREDITS.get(env.CREDITS.idFromName(name)) };
}

function ok<T>(o: LedgerOutcome<T>): T {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.value;
}

function err<T>(o: LedgerOutcome<T>) {
  if (o.ok) throw new Error("expected an error");
  return o.error;
}

async function member(plan: "starter" | "plus" | "pro" = "plus") {
  const a = account();
  const now = Date.now();
  ok(await a.stub.grant({ planId: plan, interval: "month", start: now - DAY, end: now + 29 * DAY }, `inv_${a.name}`));
  return a;
}

async function ledgerLines(stub: DurableObjectStub<import("../src/do/CreditAccount").CreditAccount>): Promise<(LedgerLine & { mirrored: boolean })[]> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec("SELECT * FROM ledger ORDER BY created_at, id")
      .toArray()
      .map((r) => ({ ...lineFromRow(r as Record<string, SqlStorageValue>), mirrored: r.mirrored_at !== null })),
  );
}

describe("CreditAccount DO", () => {
  it("migrates to schema v2 and knows its workspace", async () => {
    const { name, stub } = account();
    expect(await stub.ping()).toEqual({ ok: true, schemaVersion: 2 });
    const wsId = await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("SELECT workspace_id FROM balance").one().workspace_id);
    expect(wsId).toBe(name);
    expect(await stub.balance()).toEqual({ plan: 0, purchased: 0, held: 0, planExpiresAt: null });
  });

  it("quote prices items over the passed catalog and blocks what it cannot price", async () => {
    const { stub } = await member("starter");
    const q = ok(await stub.quote([video("a"), video("b", "1080p"), { ref: "c", modelId: "x/unknown" }, image("d")], catalog));
    expect(q.items.map((i) => [i.ref, i.credits, i.blocked ?? null])).toEqual([
      ["a", 347, null],
      ["b", 0, "resolution_locked"],
      ["c", 0, "unknown_model"],
      ["d", 11, null],
    ]);
    expect(q).toMatchObject({ total: 358, balance: 200, balanceAfter: -158 });
    expect(q.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it("hold refuses without a plan, without credits, over the member limit and over the concurrency limit", async () => {
    const none = account();
    ok(await none.stub.purchase(5000, "pi_x", "p1"));
    const q0 = ok(await none.stub.quote([image("a")], catalog));
    expect(err(await none.stub.hold({ quoteId: q0.quoteId, runId: "run_1", userId: "u1", idemKey: "h" })).code).toBe("NO_PLAN");

    const { stub } = await member("starter");
    const q1 = ok(await stub.quote([video("a")], catalog));
    expect(err(await stub.hold({ quoteId: q1.quoteId, runId: "run_1", userId: "u1", idemKey: "h1" }))).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      data: { needed: 347, balance: 200 },
    });
    ok(await stub.purchase(5000, "pi_1", "topup:pi_1"));
    expect(err(await stub.hold({ quoteId: q1.quoteId, runId: "run_1", userId: "u1", idemKey: "h2", memberMonthlyLimit: 100 }))).toMatchObject({
      code: "MEMBER_LIMIT_REACHED",
      data: { limit: 100, used: 0, needed: 347 },
    });
    const q2 = ok(await stub.quote([image("a"), image("b"), image("c")], catalog));
    expect(err(await stub.hold({ quoteId: q2.quoteId, runId: "run_2", userId: "u1", idemKey: "h3" }))).toMatchObject({
      code: "CONCURRENCY_LIMIT",
      data: { limit: 2, active: 0, requested: 3 },
    });
    expect(await stub.balance()).toMatchObject({ plan: 200, purchased: 5000, held: 0 });
  });

  it("hold, settle and release are idempotent and close a job once", async () => {
    const { stub } = await member("plus");
    const q = ok(await stub.quote([video("a"), image("b")], catalog));
    const input = { quoteId: q.quoteId, runId: "run_1", userId: "u1", idemKey: "hold-1" };
    const h = ok(await stub.hold(input));
    expect(h.jobs.map((j) => [j.ref, j.credits])).toEqual([["a", 347], ["b", 11]]);
    expect(ok(await stub.hold(input))).toEqual(h);
    expect(h.balance).toMatchObject({ plan: 800 - 358, held: 358 });

    const [a, b] = h.jobs;
    const s = ok(await stub.settle(a!.jobId, 300, "settle-a"));
    expect(s).toMatchObject({ spent: 300, returned: 47, clamped: false, balance: { plan: 442 + 47, held: 11 } });
    expect(ok(await stub.settle(a!.jobId, 300, "settle-a"))).toEqual(s);
    expect(err(await stub.settle(a!.jobId, 10, "settle-a2"))).toMatchObject({ code: "JOB_CLOSED" });
    expect(err(await stub.release(a!.jobId, "failed", "rel-a"))).toMatchObject({ code: "JOB_CLOSED" });

    const r = ok(await stub.release(b!.jobId, "provider_failed", "rel-b"));
    expect(r).toMatchObject({ refunded: 11, balance: { plan: 800 - 300, held: 0 } });
    expect(ok(await stub.release(b!.jobId, "provider_failed", "rel-b"))).toEqual(r);
    expect(err(await stub.settle("job_nope", 1, "x"))).toMatchObject({ code: "NOT_FOUND" });
    expect(err(await stub.release(b!.jobId, "other", "hold-1"))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const audit = await stub.audit();
    expect(audit.ok).toBe(true);
    expect(audit.fromLines.spent).toBe(300);
  });

  it("settle never charges more than the hold", async () => {
    const { stub } = await member("plus");
    const q = ok(await stub.quote([image("a")], catalog));
    const job = ok(await stub.hold({ quoteId: q.quoteId, runId: "run_1", userId: "u1", idemKey: "h" })).jobs[0]!;
    expect(ok(await stub.settle(job.jobId, 10_000, "s"))).toMatchObject({ spent: 11, clamped: true });
  });

  it("grant replaces leftover plan credits; purchase adds purchased credits once", async () => {
    const { stub } = await member("plus");
    const q = ok(await stub.quote([image("a")], catalog));
    const job = ok(await stub.hold({ quoteId: q.quoteId, runId: "run_1", userId: "u1", idemKey: "h" })).jobs[0]!;
    ok(await stub.settle(job.jobId, 11, "s"));
    const now = Date.now();
    const g = ok(await stub.grant({ planId: "pro", interval: "month", start: now, end: now + 30 * DAY }, "inv_next"));
    expect(g).toMatchObject({ granted: 2500, expired: 789, planExpiresAt: now + 30 * DAY });
    expect(ok(await stub.grant({ planId: "pro", interval: "month", start: now, end: now + 30 * DAY }, "inv_next"))).toEqual(g);
    expect(ok(await stub.purchase(2600, "pi_9", "topup:pi_9")).balance).toMatchObject({ plan: 2500, purchased: 2600 });
    expect(ok(await stub.purchase(2600, "pi_9", "topup:pi_9")).balance.purchased).toBe(2600);
    expect((await stub.summary()).planId).toBe("pro");
  });

  it("expires plan credits at period end via the alarm; purchased credits stay", async () => {
    const { stub } = account();
    const now = Date.now();
    ok(await stub.grant({ planId: "starter", interval: "month", start: now - 30 * DAY, end: now + 150 }, "inv_end"));
    ok(await stub.purchase(1000, "pi_e", "topup:pi_e"));
    expect((await stub.balance()).plan).toBe(200);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(now + 150);
    await new Promise((r) => setTimeout(r, 250));
    // The alarm may already have fired on its own; run it now if it has not. `balance()` does not expire lazily.
    await runDurableObjectAlarm(stub);
    expect(await stub.balance()).toEqual({ plan: 0, purchased: 1000, held: 0, planExpiresAt: null });
    const lines = await ledgerLines(stub);
    expect(lines.filter((l) => l.kind === "expire")).toMatchObject([{ bucket: "plan", amount: -200 }]);
  });

  it("cancelPlan expires plan credits and stops new holds", async () => {
    const { stub } = await member("plus");
    expect(ok(await stub.cancelPlan("cancel:sub_1"))).toMatchObject({ expired: 800, balance: { plan: 0 } });
    const q = ok(await stub.quote([image("a")], catalog));
    expect(err(await stub.hold({ quoteId: q.quoteId, runId: "r", userId: "u", idemKey: "h" })).code).toBe("NO_PLAN");
  });

  it("every mutation is sent to the ledger-mirror queue (outbox drained)", async () => {
    const { stub } = await member("plus");
    ok(await stub.purchase(1000, "pi_m", "topup:pi_m"));
    const lines = await ledgerLines(stub);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.mirrored)).toBe(true);
    expect((await stub.audit()).unmirrored).toBe(0);
  });

  it("starts one BillingWorkflow per auto top-up window", async () => {
    await using introspector = await introspectWorkflow(env.BILLING);
    const { stub } = await member("starter");
    expect(ok(await stub.setAutoTopUp({ enabled: true, thresholdCredits: 500, amountCents: 1000 }))).toEqual({ enabled: true, thresholdCredits: 500, amountCents: 1000 });
    // Balance 200 < 500: the next commit starts the workflow; further commits in the same window do not.
    ok(await stub.purchase(10, "pi_a", "p_a"));
    ok(await stub.purchase(10, "pi_b", "p_b"));
    const instances = await introspector.get();
    expect(instances).toHaveLength(1);
    // No Stripe key in tests: the workflow skips without charging.
    await instances[0]!.waitForStatus("complete");
    expect(await instances[0]!.getOutput()).toEqual({ status: "skipped", reason: "payments are not configured" });
    expect(err(await stub.setAutoTopUp({ enabled: true, thresholdCredits: 500, amountCents: 500 })).code).toBe("BAD_REQUEST");
  });
});

describe("ledger-mirror consumer", () => {
  it("writes lines to D1 idempotently and drops malformed messages", async () => {
    const { name, stub } = await member("plus");
    const q = ok(await stub.quote([image("a")], catalog));
    const job = ok(await stub.hold({ quoteId: q.quoteId, runId: "run_m", userId: "u1", idemKey: "h" })).jobs[0]!;
    ok(await stub.release(job.jobId, "provider_failed", "r"));
    const lines = (await ledgerLines(stub)).map(({ mirrored: _m, ...l }) => l);
    const body = { workspaceId: name, lines };
    const batch = createMessageBatch("rolling-dev-ledger-mirror", [
      { id: "m1", timestamp: new Date(), attempts: 1, body },
      { id: "m2", timestamp: new Date(), attempts: 1, body },
      { id: "m3", timestamp: new Date(), attempts: 1, body: { workspaceId: name, lineIds: ["x"] } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2", "m3"]);
    const rows = await env.DB.prepare("SELECT kind, bucket, amount, job_id, note FROM ledger_lines WHERE workspace_id = ? ORDER BY created_at, id").bind(name).all();
    expect(rows.results).toEqual(
      lines.map((l) => ({ kind: l.kind, bucket: l.bucket, amount: l.amount, job_id: l.jobId, note: l.note })),
    );
    expect(rows.results.filter((r) => r.kind === "refund")).toEqual([{ kind: "refund", bucket: "plan", amount: 11, job_id: job.jobId, note: "provider_failed" }]);
  });
});
