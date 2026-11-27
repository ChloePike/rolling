/**
 * Child-safety escalation (D-027, docs/trust-safety.md). A `MINOR_SEXUAL`
 * hard-limit hit, or a report a reviewer confirms, opens a restricted
 * `child_safety` case that:
 *
 * 1. preserves the evidence in the locked private prefix `evidence/<caseId>/`
 *    (copies of the blocked or reported media and the full prompt text, with
 *    SHA-256 hashes), BEFORE anything is deleted from the user's space;
 * 2. when media was involved, flags the workspace (mature runs paused) and
 *    suspends the user and the workspace until a human decides (a text-only
 *    hit is flagged by the urgent case alone);
 * 3. prefills the NCMEC CyberTipline report packet for a human to submit.
 *
 * Nothing here deletes evidence (D1 triggers and the R2 bucket lock refuse it
 * until the case is closed and the retention period has passed), and nothing
 * submits to NCMEC. Evidence bytes are never returned by any route.
 */
import { newId } from "@rolling/core/ids";
import { buildNcmecPacket, EVIDENCE_RETENTION_DAYS, type EvidenceRef } from "@rolling/core/ops/ncmec";
import { PRIORITY } from "@rolling/core/ops/trust";
import { audit, SYSTEM_ACTOR, type Actor } from "./audit";
import { EVIDENCE_PREFIX } from "./restricted";
import { notifyUser, suspend } from "./suspension";

const DAY = 86_400_000;

export interface ChildSafetyInput {
  source: "automated_check" | "user_report" | "staff";
  workspaceId: string | null;
  userId: string | null;
  stage?: string | null;
  codes?: string[];
  runId?: string | null;
  jobId?: string | null;
  safetyEventId?: string | null;
  shareId?: string | null;
  relatedCaseId?: string | null;
  /** The full text that was checked (kept only inside the locked evidence prefix). */
  prompt?: string | null;
  /** R2 keys of media to preserve (outputs, references, uploads, share snapshot). */
  objectKeys?: string[];
  /** Dedupes repeated escalations of the same thing (step retries). */
  dedupeKey?: string | null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeName(key: string): string {
  return (key.split("/").pop() ?? "object").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "object";
}

/** Copies one object into the evidence prefix and records it. Idempotent per (case, source). */
async function preserveObject(env: Env, caseId: string, sourceKey: string, index: number, retainUntil: number): Promise<boolean> {
  const seen = await env.DB.prepare("SELECT 1 AS x FROM evidence_items WHERE case_id = ? AND source_key = ?").bind(caseId, sourceKey).first();
  if (seen) return true;
  const obj = await env.MEDIA.get(sourceKey);
  if (!obj) return false;
  const bytes = await obj.arrayBuffer();
  const hash = await sha256Hex(bytes);
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const key = `${EVIDENCE_PREFIX}${caseId}/${String(index).padStart(2, "0")}-${safeName(sourceKey)}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { caseId, sha256: hash, sourceKey } });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO evidence_items (id, case_id, kind, r2_key, source_key, sha256, size, content_type, captured_at, retain_until) VALUES (?, ?, 'object', ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId("evidence"), caseId, key, sourceKey, hash, bytes.byteLength, contentType, Date.now(), retainUntil)
    .run();
  return true;
}

async function preserveText(env: Env, caseId: string, text: string, sourceKey: string, retainUntil: number): Promise<void> {
  const seen = await env.DB.prepare("SELECT 1 AS x FROM evidence_items WHERE case_id = ? AND source_key = ?").bind(caseId, sourceKey).first();
  if (seen) return;
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
  const hash = await sha256Hex(bytes);
  const key = `${EVIDENCE_PREFIX}${caseId}/${safeName(sourceKey)}.txt`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: { caseId, sha256: hash } });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO evidence_items (id, case_id, kind, r2_key, source_key, sha256, size, content_type, captured_at, retain_until) VALUES (?, ?, 'text', ?, ?, ?, ?, 'text/plain', ?, ?)",
  )
    .bind(newId("evidence"), caseId, key, sourceKey, hash, bytes.byteLength, Date.now(), retainUntil)
    .run();
}

export async function evidenceRefs(env: Env, caseId: string): Promise<EvidenceRef[]> {
  const rows = await env.DB.prepare("SELECT id, kind, sha256, size, content_type, captured_at FROM evidence_items WHERE case_id = ? ORDER BY captured_at, id").bind(caseId).all<{
    id: string;
    kind: "object" | "text";
    sha256: string | null;
    size: number | null;
    content_type: string | null;
    captured_at: number;
  }>();
  return rows.results.map((r) => ({ id: r.id, kind: r.kind, sha256: r.sha256, size: r.size, contentType: r.content_type, capturedAt: r.captured_at }));
}

/** Rebuilds the NCMEC packet from the case and its evidence (stored on the case; status kept). */
export async function refreshPacket(env: Env, caseId: string): Promise<void> {
  const c = await env.DB.prepare("SELECT * FROM trust_cases WHERE id = ?").bind(caseId).first<{
    id: string;
    workspace_id: string | null;
    user_id: string | null;
    data: string;
    created_at: number;
  }>();
  if (!c) return;
  const data = JSON.parse(c.data || "{}") as Record<string, unknown>;
  const user = c.user_id
    ? await env.DB.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").bind(c.user_id).first<{ id: string; email: string; name: string; created_at: string }>()
    : null;
  const appUrl = (env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const packet = buildNcmecPacket(
    {
      caseId: c.id,
      createdAt: c.created_at,
      source: (data.source as "automated_check" | "user_report" | "staff") ?? "automated_check",
      stage: (data.stage as string | null) ?? null,
      codes: (data.codes as string[] | undefined) ?? [],
      appUrl,
      incidentAt: (data.incidentAt as number | undefined) ?? c.created_at,
      reportedUser: { id: c.user_id, email: user?.email ?? null, name: user?.name ?? null, createdAt: user?.created_at ?? null, workspaceId: c.workspace_id },
      location: { runId: (data.runId as string | null) ?? null, jobId: (data.jobId as string | null) ?? null, shareUrl: data.shareId ? `${appUrl}/share/${String(data.shareId)}` : null },
      evidence: await evidenceRefs(env, c.id),
    },
    Date.now(),
  );
  const submission = (data.submission as Record<string, unknown> | undefined) ?? { status: "pending" };
  await env.DB.prepare("UPDATE trust_cases SET data = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify({ ...data, packet: { ...packet, submission: { ...packet.submission, ...submission } }, submission }), Date.now(), caseId)
    .run();
}

/**
 * Opens (or reuses, by dedupe key) a child-safety case and preserves its
 * evidence. Never throws on evidence copy failures of single objects (they
 * are logged and listed as missing); throws only when the case itself cannot
 * be written, so callers can log loudly.
 */
export async function openChildSafetyCase(env: Env, input: ChildSafetyInput, actor: Actor = SYSTEM_ACTOR): Promise<{ caseId: string; created: boolean; preserved: number; missing: string[] }> {
  const now = Date.now();
  const dedupe = input.dedupeKey ?? (input.jobId ? `cs:job:${input.jobId}` : input.safetyEventId ? `cs:event:${input.safetyEventId}` : input.shareId ? `cs:share:${input.shareId}` : null);
  const id = newId("case");
  const data = {
    source: input.source,
    stage: input.stage ?? null,
    codes: input.codes ?? ["MINOR_SEXUAL"],
    runId: input.runId ?? null,
    jobId: input.jobId ?? null,
    safetyEventId: input.safetyEventId ?? null,
    shareId: input.shareId ?? null,
    incidentAt: now,
    submission: { status: "pending" },
  };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO trust_cases (id, kind, status, priority, workspace_id, user_id, target_kind, target_id, category, data, dedupe_key, related_case_id, created_at, updated_at)
     VALUES (?, 'child_safety', 'open', ?, ?, ?, ?, ?, 'child_safety', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      PRIORITY.urgent,
      input.workspaceId,
      input.userId,
      input.shareId ? "share" : input.jobId ? "job" : null,
      input.shareId ?? input.jobId ?? null,
      JSON.stringify(data),
      dedupe,
      input.relatedCaseId ?? null,
      now,
      now,
    )
    .run();
  const row = dedupe
    ? await env.DB.prepare("SELECT id FROM trust_cases WHERE dedupe_key = ? AND kind = 'child_safety' ORDER BY created_at DESC LIMIT 1").bind(dedupe).first<{ id: string }>()
    : { id };
  const caseId = row?.id ?? id;
  const created = caseId === id;
  const retainUntil = now + EVIDENCE_RETENTION_DAYS * DAY;

  let preserved = 0;
  const missing: string[] = [];
  if (input.prompt) {
    try {
      await preserveText(env, caseId, input.prompt, input.jobId ? `prompt:${input.jobId}` : `prompt:${input.safetyEventId ?? now}`, retainUntil);
      preserved++;
    } catch (err) {
      console.error(JSON.stringify({ msg: "child safety: prompt evidence failed", caseId, error: String(err) }));
    }
  }
  for (const [i, key] of [...new Set(input.objectKeys ?? [])].entries()) {
    try {
      if (await preserveObject(env, caseId, key, i, retainUntil)) preserved++;
      else missing.push(key);
    } catch (err) {
      missing.push(key);
      console.error(JSON.stringify({ msg: "child safety: object evidence failed", caseId, error: String(err) }));
    }
  }

  // Media involved (outputs, references, uploads, a shared work): the workspace is flagged (mature paused) and
  // generation stops until a human decides. A text-only hit is flagged by the urgent case itself (rules can misfire on text).
  const media = (input.objectKeys?.length ?? 0) > 0 || !!input.shareId;
  if (media && input.workspaceId) {
    await env.DB.prepare("UPDATE workspaces SET safety_flag = 1, safety_flagged_at = COALESCE(safety_flagged_at, ?) WHERE id = ?").bind(now, input.workspaceId).run();
  }
  if (created && media) {
    if (input.userId) await suspend(env, { kind: "user", id: input.userId }, "Child-safety case pending review", actor.id ?? "system", caseId);
    if (input.workspaceId) await suspend(env, { kind: "workspace", id: input.workspaceId }, "Child-safety case pending review", actor.id ?? "system", caseId);
    if (input.userId) await notifyUser(env, { userId: input.userId, workspaceId: input.workspaceId, kind: "suspended", message: "Generation and the agent are paused on this account while we review recent activity.", caseId });
  }
  await refreshPacket(env, caseId);
  if (created) {
    await audit(env, actor, {
      action: "child_safety.case_opened",
      target: { kind: "case", id: caseId },
      reason: input.source,
      data: { workspaceId: input.workspaceId, userId: input.userId, preserved, missing: missing.length, suspended: media },
    });
  }
  console.warn(JSON.stringify({ msg: "child safety: case", caseId, created, preserved, missing: missing.length }));
  return { caseId, created, preserved, missing };
}
