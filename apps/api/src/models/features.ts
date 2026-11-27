/**
 * Gateway features the account may not have yet (D-020). Hyperouter answers
 * `403 feature_not_enabled` to `prompt_expand` until it enables the feature for
 * the account; the first such answer stores the feature as off for this
 * environment (D1 `gateway_features`), so later quotes neither price nor send
 * it and the toggle shows "Not available yet". The model sync (cron) clears an
 * off flag after FEATURE_RECHECK_MS, so the next run tries again (a refused try
 * costs nothing: nothing is held or sent, and the job resubmits without it).
 */
export type GatewayFeature = "prompt_expand";

/** How long an off flag stands before a run may try the feature again. */
export const FEATURE_RECHECK_MS = 24 * 60 * 60 * 1000;

/** Per-isolate copy of the flag (one D1 read per minute at most on hot paths). */
const memo = new Map<GatewayFeature, { enabled: boolean; at: number }>();
const MEMO_MS = 60_000;

/** Tests: forget the per-isolate copy. */
export function resetFeatureMemoForTests(): void {
  memo.clear();
}

/** False while the gateway refused the feature in this environment; true otherwise (unknown = try it). */
export async function gatewayFeatureEnabled(env: Env, feature: GatewayFeature, now = Date.now()): Promise<boolean> {
  const hit = memo.get(feature);
  if (hit && now - hit.at < MEMO_MS) return hit.enabled;
  let enabled = true;
  try {
    const row = await env.DB.prepare("SELECT enabled FROM gateway_features WHERE feature = ?").bind(feature).first<{ enabled: number }>();
    enabled = row ? row.enabled === 1 : true;
  } catch (err) {
    // A missing table (migration not applied yet) must not break quotes.
    console.warn(JSON.stringify({ msg: "features: read failed", feature, error: String(err) }));
  }
  memo.set(feature, { enabled, at: now });
  return enabled;
}

/** Stores the feature as off (the gateway answered `feature_not_enabled`). */
export async function markGatewayFeatureOff(env: Env, feature: GatewayFeature, reason: string, now = Date.now()): Promise<void> {
  memo.set(feature, { enabled: false, at: now });
  await env.DB.prepare(
    "INSERT INTO gateway_features (feature, enabled, reason, checked_at) VALUES (?1, 0, ?2, ?3) ON CONFLICT(feature) DO UPDATE SET enabled = 0, reason = ?2, checked_at = ?3",
  )
    .bind(feature, reason.slice(0, 300), now)
    .run();
  console.warn(JSON.stringify({ msg: "features: gateway feature off", feature, reason: reason.slice(0, 300) }));
}

/** Cron (model sync): off flags older than FEATURE_RECHECK_MS are cleared so the next run tries again. Returns the cleared features. */
export async function recheckGatewayFeatures(env: Env, now = Date.now()): Promise<string[]> {
  const rows = await env.DB.prepare("DELETE FROM gateway_features WHERE enabled = 0 AND checked_at < ? RETURNING feature")
    .bind(now - FEATURE_RECHECK_MS)
    .all<{ feature: string }>();
  for (const r of rows.results) memo.delete(r.feature as GatewayFeature);
  return rows.results.map((r) => r.feature);
}
