/**
 * Status page model (D-029): components, how a run of probes maps to a
 * status, and the overall banner state.
 */
export const STATUS_COMPONENTS = ['api', 'gateway', 'media', 'auth'] as const;
export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'unknown';

export interface ProbeResult {
  component: StatusComponent;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: number;
}

/** Probes older than this say nothing (the cron runs every 5 minutes). */
export const STALE_AFTER_MS = 20 * 60_000;
/** Slower than this is degraded. */
export const SLOW_MS: Record<StatusComponent, number> = { api: 1500, gateway: 4000, media: 2000, auth: 1500 };

/**
 * Status from the newest probes of one component (newest first): down when
 * the last two failed, degraded when the last one failed or was slow,
 * operational otherwise; unknown without a recent probe.
 */
export function componentStatus(component: StatusComponent, recent: readonly ProbeResult[], now: number): ComponentStatus {
  const last = recent[0];
  if (!last || now - last.checkedAt > STALE_AFTER_MS) return 'unknown';
  if (!last.ok) return recent[1] && !recent[1].ok ? 'down' : 'degraded';
  if (last.latencyMs !== null && last.latencyMs > SLOW_MS[component]) return 'degraded';
  return 'operational';
}

export type Overall = 'operational' | 'degraded' | 'outage';

export function overallStatus(statuses: readonly ComponentStatus[], breakerOpen: boolean): Overall {
  if (statuses.includes('down')) return 'outage';
  if (breakerOpen || statuses.includes('degraded')) return 'degraded';
  return 'operational';
}

/** Uptime share of a component over its probes (1 = every probe ok). */
export function uptime(probes: readonly Pick<ProbeResult, 'ok'>[]): number | null {
  if (probes.length === 0) return null;
  return probes.filter((p) => p.ok).length / probes.length;
}

export interface Incident {
  message: string;
  level: 'info' | 'degraded' | 'outage';
  updatedAt: number;
}

export const INCIDENT_MAX = 280;
