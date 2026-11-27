/**
 * Status page (D-029): probes every 5 minutes (the sweep cron) for the API
 * (D1), the generation gateway (Hyperouter's free model listing, never a
 * paid call), media (R2) and auth (Better Auth's `/ok` plus its session
 * table). Results go to D1 `status_checks` (30 days) and Analytics Engine.
 * `GET /api/status` is public and cached at the edge for 30 s; it carries the
 * incident banner text edited in /admin and the breaker state.
 */
import { componentStatus, INCIDENT_MAX, overallStatus, STATUS_COMPONENTS, uptime, type ComponentStatus, type Incident, type ProbeResult, type StatusComponent } from "@rolling/core/ops/status";
import { phaseOf } from "@rolling/core/ops/breaker";
import { getAuth } from "../auth/betterAuth";
import { WEB_PREFIX } from "../lib/r2Static";
import { gatewayConfigured, modelGateway } from "../runs/provider";
import { readBreaker, recordGatewayFailure, recordGatewaySuccess } from "./breaker";
import { writeMetric } from "./metrics";

const KEEP_MS = 30 * 86_400_000;
const PROBE_TIMEOUT_MS = 5000;

async function timed(component: StatusComponent, fn: () => Promise<{ ok: boolean; detail?: string | null }>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const r = await Promise.race([
      fn(),
      new Promise<{ ok: boolean; detail: string }>((resolve) => setTimeout(() => resolve({ ok: false, detail: "timeout" }), PROBE_TIMEOUT_MS)),
    ]);
    return { component, ok: r.ok, latencyMs: Date.now() - started, detail: r.detail ?? null, checkedAt: Date.now() };
  } catch (err) {
    return { component, ok: false, latencyMs: Date.now() - started, detail: String(err).slice(0, 200), checkedAt: Date.now() };
  }
}

let probeOverrides: Partial<Record<StatusComponent, () => Promise<{ ok: boolean; detail?: string | null }>>> = {};

/** Tests: replace a probe. */
export function setProbeForTests(component: StatusComponent, fn: (() => Promise<{ ok: boolean; detail?: string | null }>) | null): void {
  if (fn) probeOverrides[component] = fn;
  else delete probeOverrides[component];
}

export function resetProbesForTests(): void {
  probeOverrides = {};
}

const PROBES: Record<StatusComponent, (env: Env) => Promise<{ ok: boolean; detail?: string | null }>> = {
  api: async (env) => {
    const r = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return { ok: r?.ok === 1 };
  },
  gateway: async (env) => {
    if (!gatewayConfigured(env)) return { ok: false, detail: "gateway not configured" };
    const h = await modelGateway(env).health(PROBE_TIMEOUT_MS - 500);
    return { ok: h.ok, detail: h.detail };
  },
  media: async (env) => {
    await env.MEDIA.head(`${WEB_PREFIX}/index.html`);
    return { ok: true };
  },
  auth: async (env) => {
    const auth = await getAuth(env);
    const base = (env.PUBLIC_APP_URL || "http://localhost").replace(/\/+$/, "");
    const res = await auth.handler(new Request(`${base}/api/auth/ok`));
    await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE rowid = (SELECT MAX(rowid) FROM sessions)").first();
    return { ok: res.ok, detail: res.ok ? null : `HTTP ${res.status}` };
  },
};

/** Runs every probe once, stores the results, feeds the breaker with the gateway result. */
export async function runStatusProbes(env: Env): Promise<ProbeResult[]> {
  const results = await Promise.all(STATUS_COMPONENTS.map((c) => timed(c, () => (probeOverrides[c] ?? PROBES[c])(env))));
  await env.DB.batch([
    ...results.map((r) =>
      env.DB.prepare("INSERT INTO status_checks (component, ok, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?)").bind(r.component, r.ok ? 1 : 0, r.latencyMs, r.detail, r.checkedAt),
    ),
    env.DB.prepare("DELETE FROM status_checks WHERE checked_at < ?").bind(Date.now() - KEEP_MS),
  ]);
  for (const r of results) writeMetric(env, { event: "probe", blobs: [r.component, r.ok ? "ok" : "fail"], doubles: [r.ok ? 1 : 0, r.latencyMs ?? 0] });
  const gw = results.find((r) => r.component === "gateway");
  if (gw && gatewayConfigured(env)) {
    // A half-open breaker closes when the gateway answers; a failing probe counts like a failed call.
    const breaker = await readBreaker(env, undefined, true);
    if (gw.ok && phaseOf(breaker, Date.now()) !== "open") await recordGatewaySuccess(env);
    else if (!gw.ok) await recordGatewayFailure(env, `probe: ${gw.detail ?? "failed"}`);
  }
  return results;
}

export async function readIncident(env: Env): Promise<Incident | null> {
  const row = await env.DB.prepare("SELECT value, updated_at FROM ops_settings WHERE key = 'incident'").first<{ value: string; updated_at: number }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<Incident>;
    if (!v.message) return null;
    return { message: String(v.message).slice(0, INCIDENT_MAX), level: v.level === "outage" || v.level === "degraded" ? v.level : "info", updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

/** Sets (or clears with an empty message) the banner. The admin route audits it. */
export async function writeIncident(env: Env, incident: { message: string; level: Incident["level"] }, by: string | null): Promise<Incident | null> {
  const message = incident.message.trim().slice(0, INCIDENT_MAX);
  if (!message) {
    await env.DB.prepare("DELETE FROM ops_settings WHERE key = 'incident'").run();
    return null;
  }
  const now = Date.now();
  await env.DB.prepare("INSERT INTO ops_settings (key, value, updated_at, updated_by) VALUES ('incident', ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .bind(JSON.stringify({ message, level: incident.level }), now, by)
    .run();
  return { message, level: incident.level, updatedAt: now };
}

export interface StatusView {
  overall: "operational" | "degraded" | "outage";
  components: { id: StatusComponent; status: ComponentStatus; latencyMs: number | null; checkedAt: number | null; uptime24h: number | null }[];
  generation: { available: boolean; breaker: "closed" | "open" | "half_open"; since: number | null };
  incident: Incident | null;
  updatedAt: number;
}

export async function statusView(env: Env, now = Date.now()): Promise<StatusView> {
  const since = now - 86_400_000;
  const rows = await env.DB.prepare("SELECT component, ok, latency_ms, detail, checked_at FROM status_checks WHERE checked_at > ? ORDER BY checked_at DESC LIMIT 2000")
    .bind(since)
    .all<{ component: StatusComponent; ok: number; latency_ms: number | null; detail: string | null; checked_at: number }>();
  const by = new Map<StatusComponent, ProbeResult[]>();
  for (const r of rows.results) {
    const list = by.get(r.component) ?? [];
    list.push({ component: r.component, ok: r.ok === 1, latencyMs: r.latency_ms, detail: r.detail, checkedAt: r.checked_at });
    by.set(r.component, list);
  }
  const breaker = await readBreaker(env);
  const phase = phaseOf(breaker, now);
  const components = STATUS_COMPONENTS.map((id) => {
    const list = by.get(id) ?? [];
    let status = componentStatus(id, list, now);
    // The breaker is the live truth for generation: open means degraded at least.
    if (id === "gateway" && phase === "open" && (status === "operational" || status === "unknown")) status = "degraded";
    return { id, status, latencyMs: list[0]?.latencyMs ?? null, checkedAt: list[0]?.checkedAt ?? null, uptime24h: uptime(list) };
  });
  return {
    overall: overallStatus(
      components.map((c) => c.status),
      phase === "open",
    ),
    components,
    generation: { available: phase !== "open", breaker: phase, since: phase === "open" ? breaker.openedAt : null },
    incident: await readIncident(env),
    updatedAt: now,
  };
}
