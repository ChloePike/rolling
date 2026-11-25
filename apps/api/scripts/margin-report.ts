/**
 * Monthly gross margin report (ops, D-006 / D-012 / D-013). Reads D1 through
 * `wrangler d1 execute --json` and prints, per plan × interval: revenue
 * (subscriptions at their monthly-equivalent price + top-ups paid in the
 * month), credits consumed at gateway cost, agent usage USD (all turns,
 * unmetered DeepSeek included), estimated card fees (4.65% + $0.30 per
 * charge) and 2% infra; flags margins under 50% (Team: 60%).
 *
 *   pnpm --filter @rolling/api margin:report -- --month 2026-11 [--env staging|production] [--json]
 *
 * Without `--env` it reads the local dev database (`--local`). Read-only.
 * Subscription revenue is the configured price (Stripe invoices are not
 * mirrored to D1); prorations, discounts, taxes and refunds are not included.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMarginReport, type MarginInput, type MarginRow } from "@rolling/core/pricing/margin";
import type { PlanId } from "@rolling/core/pricing/config";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const envName = flag("env");
const json = args.includes("--json");
const month = flag("month") ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
const m = /^(\d{4})-(\d{2})$/.exec(month);
if (!m) {
  console.error("--month must be YYYY-MM");
  process.exit(1);
}
const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
const database = envName ? `rolling-${envName}` : "rolling-dev";
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function query<T>(sql: string): T[] {
  const out = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", database, "--json", "--command", sql, ...(envName ? ["--remote", "--env", envName] : ["--local"])],
    { cwd: apiDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

const PLANS: readonly string[] = ["starter", "plus", "pro", "team"];

const subscriptions = query<{ workspace_id: string; plan: string; interval: string; seats: number | null }>(
  `SELECT s.workspace_id, s.plan, s.interval, s.seats FROM subscriptions s
   WHERE s.status IN ('active','trialing','past_due') AND s.current_period_end > ${start} AND (s.current_period_start IS NULL OR s.current_period_start < ${end})
     AND s.current_period_end = (SELECT MAX(x.current_period_end) FROM subscriptions x WHERE x.workspace_id = s.workspace_id AND x.status IN ('active','trialing','past_due'))`,
)
  .filter((r) => PLANS.includes(r.plan) && (r.interval === "month" || r.interval === "year"))
  .map((r) => ({ workspaceId: r.workspace_id, plan: r.plan as PlanId, interval: r.interval as "month" | "year", seats: r.seats ?? 1 }));

const topUps = query<{ workspace_id: string; amount_cents: number }>(
  `SELECT workspace_id, amount_cents FROM checkout_sessions WHERE kind = 'topUp' AND status = 'complete' AND amount_cents IS NOT NULL AND completed_at >= ${start} AND completed_at < ${end}`,
).map((r) => ({ workspaceId: r.workspace_id, amountCents: r.amount_cents }));

// Settle lines carry the charged credits as a negative amount.
const creditsConsumed = query<{ workspace_id: string; credits: number }>(
  `SELECT workspace_id, -SUM(amount) AS credits FROM ledger_lines WHERE kind = 'settle' AND created_at >= ${start} AND created_at < ${end} GROUP BY workspace_id`,
).map((r) => ({ workspaceId: r.workspace_id, credits: r.credits }));

const agentUsd = query<{ workspace_id: string; usd: number }>(
  `SELECT workspace_id, SUM(cost_usd) AS usd FROM agent_usage WHERE created_at >= ${start} AND created_at < ${end} GROUP BY workspace_id`,
).map((r) => ({ workspaceId: r.workspace_id, usd: r.usd }));

const input: MarginInput = { subscriptions, topUps, creditsConsumed, agentUsd };
const rows = computeMarginReport(input);

if (json) {
  console.log(JSON.stringify({ month, database, rows }, null, 2));
} else {
  const pct = (r: MarginRow) => (r.margin === null ? "   n/a" : `${(r.margin * 100).toFixed(1).padStart(5)}%`);
  const usd = (n: number) => `$${n.toFixed(2)}`.padStart(11);
  console.log(`Gross margin ${month} (${database})`);
  console.log(["plan".padEnd(14), "ws".padStart(5), "revenue".padStart(11), "credits".padStart(11), "agent".padStart(11), "fees".padStart(11), "infra".padStart(11), "gross".padStart(11), "margin".padStart(7), ""].join(" "));
  for (const r of rows) {
    const flagText = r.belowFloor ? `  BELOW ${(r.floor * 100).toFixed(0)}%` : "";
    console.log([r.key.padEnd(14), String(r.workspaces).padStart(5), usd(r.revenueUsd), usd(r.creditCostUsd), usd(r.agentUsd), usd(r.cardFeesUsd), usd(r.infraUsd), usd(r.grossMarginUsd), pct(r)].join(" ") + flagText);
  }
  const below = rows.filter((r) => r.belowFloor);
  if (below.length) console.log(`\n${below.length} plan(s) below the margin floor: ${below.map((r) => r.key).join(", ")}`);
}
