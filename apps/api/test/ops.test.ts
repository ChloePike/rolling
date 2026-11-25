/**
 * Ops crons: the runs safety net (stalled pending items re-advanced), the
 * media re-queue for uploads left `processing: pending`, and the nightly
 * ledger reconcile.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { lineFromRow } from "../src/do/creditStore";
import { reconcileLedgers, reconcileWorkspace } from "../src/ops/reconcile";
import { writeLedgerLines } from "../src/queues/ledgerMirror";
import { describe, expect, it } from "vitest";
import { requeuePendingMedia } from "../src/queues/mediaProcess";
import { advanceStalledRuns, STALLED_PENDING_MS } from "../src/runs/service";

let seq = 0;
const uid = (tag: string) => `${tag}${Date.now().toString(36)}${++seq}`;

async function runWithItems(items: { ref: string; status: string; dependsOn?: string[]; updatedAt: number }[]) {
  const ws = uid("ws_ops");
  const runId = uid("run_ops");
  const now = Date.now();
  await env.DB.prepare("INSERT INTO runs (id, workspace_id, project_id, quote_id, scope, status, created_by, created_at, updated_at) VALUES (?, ?, NULL, 'qt_x', 'all', 'running', 'usr_ops', ?, ?)")
    .bind(runId, ws, now, now)
    .run();
  for (const i of items) {
    await env.DB.prepare("INSERT INTO run_items (run_id, ref, kind, model, spec, depends_on, credits, status, updated_at) VALUES (?, ?, 'image', 'm', '{}', ?, 10, ?, ?)")
      .bind(runId, i.ref, JSON.stringify(i.dependsOn ?? []), i.status, i.updatedAt)
      .run();
  }
  return { ws, runId };
}

const itemStatus = async (runId: string, ref: string) =>
  (await env.DB.prepare("SELECT status FROM run_items WHERE run_id = ? AND ref = ?").bind(runId, ref).first<{ status: string }>())!.status;

describe("runs safety net (cron)", () => {
  it("advances workspaces whose pending items have waited more than 2 minutes", async () => {
    const old = Date.now() - STALLED_PENDING_MS - 1000;
    const stalled = await runWithItems([
      { ref: "a", status: "failed", updatedAt: old },
      { ref: "b", status: "pending", dependsOn: ["a"], updatedAt: old },
    ]);
    const fresh = await runWithItems([
      { ref: "a", status: "failed", updatedAt: Date.now() },
      { ref: "b", status: "pending", dependsOn: ["a"], updatedAt: Date.now() },
    ]);
    const out = await advanceStalledRuns(env);
    expect(out.workspaces).toBeGreaterThanOrEqual(1);
    // advanceRun ran for the stalled workspace (its dependent is skipped), not for the fresh one.
    expect(await itemStatus(stalled.runId, "b")).toBe("skipped");
    expect(await itemStatus(fresh.runId, "b")).toBe("pending");
  });
});

describe("media re-queue (cron)", () => {
  it("re-queues uploads left processing: pending only when the container is reachable", async () => {
    const id = uid("ast_pend");
    await env.DB.prepare("INSERT INTO assets (id, workspace_id, kind, source, name, r2_key, meta, created_by, created_at, status, mature) VALUES (?, 'ws_x', 'video', 'mine', 'clip', ?, ?, 'usr_x', ?, 'ready', 0)")
      .bind(id, `ws/ws_x/uploads/${id}/clip.mp4`, JSON.stringify({ processing: "pending" }), Date.now())
      .run();
    expect(await requeuePendingMedia(env, { reachable: async () => false })).toEqual({ requeued: 0 });
    const sent = await requeuePendingMedia(env, { reachable: async () => true });
    expect(sent.requeued).toBeGreaterThanOrEqual(1);
  });
});

describe("nightly ledger reconcile", () => {
  it("matches the DO against the D1 mirror and reports mismatches", async () => {
    const ws = uid("ws_rec");
    const stub = env.CREDITS.get(env.CREDITS.idFromName(ws));
    const out = await stub.purchase(1200, "pi_rec", `topup:${ws}`);
    expect(out.ok).toBe(true);
    const lines = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec("SELECT * FROM ledger ORDER BY created_at, id").toArray().map((r) => lineFromRow(r as Record<string, SqlStorageValue>)),
    );
    await writeLedgerLines(env, { workspaceId: ws, lines: lines.map(({ idemKey: _k, ...l }) => l) });
    const cutoff = Date.now() + 1;
    expect(await reconcileWorkspace(env, ws, cutoff)).toMatchObject({ status: "ok", doLines: lines.length, d1Lines: lines.length, diff: { plan: 0, purchased: 0, held: 0 } });

    // A line the DO never wrote: mirror mismatch.
    await env.DB.prepare("INSERT INTO ledger_lines (id, workspace_id, user_id, kind, bucket, amount, run_id, job_id, stripe_ref, created_at) VALUES (?, ?, NULL, 'adjust', 'purchased', 5, NULL, NULL, NULL, ?)")
      .bind(`led_bogus_${ws}`, ws, Date.now() - 60_000)
      .run();
    expect(await reconcileWorkspace(env, ws, Date.now() + 1)).toMatchObject({ status: "mirror_mismatch", diff: { purchased: -5 } });
    const nightly = await reconcileLedgers(env, Date.now() + 11 * 60_000);
    expect(nightly.mismatches.map((m) => m.workspaceId)).toContain(ws);
  });
});
