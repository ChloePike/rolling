/**
 * Product metrics (D-029). Writes Analytics Engine data points for signups,
 * trial and plan starts, generations (started, succeeded, failed per model),
 * agent turns, spend, API request timing per colo (from the same numbers as
 * `Server-Timing`), status probes and breaker changes. No prompts, emails or
 * names: ids, model ids, counts, credits, USD and milliseconds only.
 *
 * AE layout: index1 = event, blob1 = event, blob2.. = dimensions,
 * double1.. = values (see each writer).
 *
 * The admin dashboard reads business metrics from D1 (exact, no extra
 * credentials) and request latency from the AE SQL API when
 * `CF_ANALYTICS_TOKEN` is set (an API token with Account Analytics Read).
 */
import { lastDays, margin, percentile, successRate, type MetricPoint } from "@rolling/core/ops/metrics";

interface AnalyticsLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

/** Never throws; a missing binding is a no-op. */
export function writeMetric(env: Env, point: MetricPoint): void {
  try {
    const ae = (env as { AE?: AnalyticsLike }).AE;
    ae?.writeDataPoint({ indexes: [point.event], blobs: [point.event, ...(point.blobs ?? []).map((b) => (b === null ? null : String(b).slice(0, 96)))], doubles: point.doubles ?? [] });
  } catch {
    // Analytics never breaks a request.
  }
}

export const trackSignup = (env: Env) => writeMetric(env, { event: "signup", doubles: [1] });
export const trackPlanStart = (env: Env, plan: string, interval: string, trial: boolean) =>
  writeMetric(env, { event: trial ? "trial_start" : "plan_start", blobs: [plan, interval], doubles: [1] });
/** `outcome`: started | succeeded | failed. double2 = credits, double3 = gateway USD, double4 = ms since the job was created. */
export const trackGeneration = (env: Env, input: { model: string; kind: string; outcome: "started" | "succeeded" | "failed"; credits?: number; costUsd?: number | null; ms?: number | null; code?: string | null }) =>
  writeMetric(env, { event: "generation", blobs: [input.model, input.kind, input.outcome, input.code ?? null], doubles: [1, input.credits ?? 0, input.costUsd ?? 0, input.ms ?? 0] });
export const trackSpend = (env: Env, credits: number, model: string) => writeMetric(env, { event: "spend", blobs: [model], doubles: [credits] });
export const trackAgentTurn = (env: Env, llm: string, costUsd: number) => writeMetric(env, { event: "agent_turn", blobs: [llm], doubles: [1, costUsd] });

/** Request timing (index `request`): blob2 colo, blob3 route group, blob4 method, blob5 status class; double1 total ms, double2 D1 ms. */
export const trackRequest = (env: Env, input: { colo: string | null; route: string; method: string; status: number; ms: number; d1Ms: number }) =>
  writeMetric(env, { event: "request", blobs: [input.colo ?? "unknown", input.route, input.method, `${Math.floor(input.status / 100)}xx`], doubles: [input.ms, input.d1Ms] });

// ----------------------------------------------------------------------------- dashboard (D1)

export interface Dashboard {
  days: string[];
  daily: { day: string; signups: number; planStarts: number; started: number; succeeded: number; failed: number; agentTurns: number; creditsSpent: number; gatewayCostUsd: number; agentCostUsd: number }[];
  models: { model: string; started: number; succeeded: number; failed: number; successRate: number | null; creditsSpent: number; gatewayCostUsd: number; p50Ms: number | null; p90Ms: number | null }[];
  totals: { signups: number; planStarts: number; trialsActive: number; activePlans: number; creditsSpent: number; gatewayCostUsd: number; agentCostUsd: number; revenueUsd: number; marginUsd: number; marginPct: number | null };
  latency: { available: boolean; reason: string | null; colos: { colo: string; requests: number; p50Ms: number | null; p90Ms: number | null }[] };
}

const DAY = 86_400_000;

export async function dashboard(env: Env, days = 30, now = Date.now()): Promise<Dashboard> {
  const keys = lastDays(days, now);
  const since = Date.parse(`${keys[0]}T00:00:00Z`);
  const sinceIso = new Date(since).toISOString();
  const [signups, planStarts, jobs, spend, agent, subs, durations] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day").bind(sinceIso),
    // A plan start = the first plan grant of a workspace (comp grants included).
    env.DB.prepare(
      "SELECT date(first / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM (SELECT workspace_id, MIN(created_at) AS first FROM ledger_lines WHERE kind = 'grant' AND bucket = 'plan' GROUP BY workspace_id) WHERE first >= ? GROUP BY day",
    ).bind(since),
    env.DB.prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, model, COUNT(*) AS started,
         SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(COALESCE(cost_actual, 0)) AS credits, SUM(COALESCE(gateway_cost_usd, 0)) AS cost
       FROM jobs WHERE created_at >= ? GROUP BY day, model`,
    ).bind(since),
    env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, -SUM(amount) AS credits FROM ledger_lines WHERE kind = 'settle' AND created_at >= ? GROUP BY day").bind(since),
    env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(cost_usd) AS cost FROM agent_usage WHERE created_at >= ? GROUP BY day").bind(since),
    env.DB.prepare(
      "SELECT SUM(CASE WHEN status = 'trialing' THEN 1 ELSE 0 END) AS trials, SUM(CASE WHEN status IN ('active','trialing') THEN 1 ELSE 0 END) AS active FROM subscriptions WHERE current_period_end > ?",
    ).bind(now),
    env.DB.prepare("SELECT model, finished_at - created_at AS ms FROM jobs WHERE status = 'succeeded' AND finished_at IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 5000").bind(now - 7 * DAY),
  ]);
  const byDay = new Map(keys.map((d) => [d, { day: d, signups: 0, planStarts: 0, started: 0, succeeded: 0, failed: 0, agentTurns: 0, creditsSpent: 0, gatewayCostUsd: 0, agentCostUsd: 0 }]));
  const num = (v: unknown) => Number(v ?? 0) || 0;
  for (const r of signups?.results ?? []) {
    const d = byDay.get(String(r.day));
    if (d) d.signups = num(r.n);
  }
  for (const r of planStarts?.results ?? []) {
    const d = byDay.get(String(r.day));
    if (d) d.planStarts = num(r.n);
  }
  const models = new Map<string, Dashboard["models"][number]>();
  for (const r of jobs?.results ?? []) {
    const d = byDay.get(String(r.day));
    if (d) {
      d.started += num(r.started);
      d.succeeded += num(r.succeeded);
      d.failed += num(r.failed);
      d.gatewayCostUsd += num(r.cost);
    }
    const m = models.get(String(r.model)) ?? { model: String(r.model), started: 0, succeeded: 0, failed: 0, successRate: null, creditsSpent: 0, gatewayCostUsd: 0, p50Ms: null, p90Ms: null };
    m.started += num(r.started);
    m.succeeded += num(r.succeeded);
    m.failed += num(r.failed);
    m.creditsSpent += num(r.credits);
    m.gatewayCostUsd += num(r.cost);
    models.set(m.model, m);
  }
  for (const r of spend?.results ?? []) {
    const d = byDay.get(String(r.day));
    if (d) d.creditsSpent = num(r.credits);
  }
  for (const r of agent?.results ?? []) {
    const d = byDay.get(String(r.day));
    if (d) {
      d.agentTurns = num(r.n);
      d.agentCostUsd = num(r.cost);
    }
  }
  const ms = new Map<string, number[]>();
  for (const r of durations?.results ?? []) {
    const list = ms.get(String(r.model)) ?? [];
    list.push(num(r.ms));
    ms.set(String(r.model), list);
  }
  for (const m of models.values()) {
    m.successRate = successRate(m.succeeded, m.failed);
    const list = ms.get(m.model) ?? [];
    m.p50Ms = percentile(list, 50);
    m.p90Ms = percentile(list, 90);
    m.gatewayCostUsd = Math.round(m.gatewayCostUsd * 10000) / 10000;
  }
  const daily = [...byDay.values()].map((d) => ({ ...d, gatewayCostUsd: Math.round(d.gatewayCostUsd * 10000) / 10000, agentCostUsd: Math.round(d.agentCostUsd * 10000) / 10000 }));
  const creditsSpent = daily.reduce((s, d) => s + d.creditsSpent, 0);
  const gatewayCostUsd = daily.reduce((s, d) => s + d.gatewayCostUsd, 0);
  const agentCostUsd = daily.reduce((s, d) => s + d.agentCostUsd, 0);
  const m = margin(creditsSpent, gatewayCostUsd + agentCostUsd);
  const sub = subs?.results?.[0] ?? {};
  return {
    days: keys,
    daily,
    models: [...models.values()].sort((a, b) => b.started - a.started),
    totals: {
      signups: daily.reduce((s, d) => s + d.signups, 0),
      planStarts: daily.reduce((s, d) => s + d.planStarts, 0),
      trialsActive: num(sub.trials),
      activePlans: num(sub.active),
      creditsSpent,
      gatewayCostUsd: Math.round(gatewayCostUsd * 100) / 100,
      agentCostUsd: Math.round(agentCostUsd * 100) / 100,
      revenueUsd: m.revenueUsd,
      marginUsd: m.marginUsd,
      marginPct: m.marginPct,
    },
    latency: await latencyByColo(env, Math.min(days, 7)),
  };
}

/** Dataset name per environment (wrangler.jsonc `analytics_engine_datasets`). */
export function datasetName(env: Env): string {
  return env.ENVIRONMENT === "production" ? "rolling_production" : env.ENVIRONMENT === "staging" ? "rolling_staging" : "rolling_dev";
}

let aeFetch: typeof fetch | null = null;
export function setAnalyticsFetchForTests(fn: typeof fetch | null): void {
  aeFetch = fn;
}

/** p50/p90 API latency per colo from AE (`request` points). Needs CF_ANALYTICS_TOKEN. */
export async function latencyByColo(env: Env, days: number): Promise<Dashboard["latency"]> {
  const token = env.CF_ANALYTICS_TOKEN;
  const account = env.R2_ACCOUNT_ID;
  if (!token || !account) return { available: false, reason: "Set the CF_ANALYTICS_TOKEN secret (Account Analytics Read) to see latency per colo.", colos: [] };
  const sql = `SELECT blob2 AS colo, SUM(_sample_interval) AS requests,
      quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, quantileExactWeighted(0.9)(double1, _sample_interval) AS p90
    FROM ${datasetName(env)} WHERE index1 = 'request' AND timestamp > NOW() - INTERVAL '${Math.max(1, Math.min(30, days))}' DAY
    GROUP BY colo ORDER BY requests DESC LIMIT 30 FORMAT JSON`;
  try {
    const res = await (aeFetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: sql });
    if (!res.ok) return { available: false, reason: `Analytics Engine answered ${res.status}.`, colos: [] };
    const body = (await res.json()) as { data?: { colo: string; requests: number | string; p50: number | string; p90: number | string }[] };
    return {
      available: true,
      reason: null,
      colos: (body.data ?? []).map((r) => ({ colo: r.colo, requests: Number(r.requests) || 0, p50Ms: r.p50 === undefined ? null : Math.round(Number(r.p50)), p90Ms: r.p90 === undefined ? null : Math.round(Number(r.p90)) })),
    };
  } catch (err) {
    return { available: false, reason: `Analytics Engine unavailable: ${String(err).slice(0, 120)}`, colos: [] };
  }
}
