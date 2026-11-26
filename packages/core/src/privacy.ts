/**
 * Privacy and retention configuration: the one place that sets how long we
 * keep data after the fact and how account deletion and data export behave.
 * `legal/privacy-policy.md` ("How long we keep data", "When you delete your
 * account", "Your rights") quotes these values; change both together.
 */

const DAY_MS = 86_400_000;

/** Safety review log (`safety_events`): rows older than this are deleted by the daily purge. */
export const SAFETY_LOG_RETENTION_DAYS = 365;
/** Prompt excerpts in the safety log are cleared (set to null) after this many days; the row stays. */
export const SAFETY_EXCERPT_RETENTION_DAYS = 90;
/** Agent usage records (`agent_usage`, D-012): rows older than this are deleted by the daily purge. */
export const AGENT_USAGE_RETENTION_DAYS = 400;

/** Account deletion: everything the background job removes (Durable Object storage, media) is gone within this many days. */
export const ACCOUNT_DELETION_DEADLINE_DAYS = 30;
/** A pending deletion job that has not finished after this long is restarted by the daily cron. */
export const ACCOUNT_DELETION_RESTART_AFTER_MS = 60 * 60_000;

/** Data export (Settings → Account → Export my data): one request per this many hours. */
export const DATA_EXPORT_COOLDOWN_HOURS = 24;
/** Lifetime of the emailed download link and of the bundle in storage. */
export const DATA_EXPORT_LINK_TTL_DAYS = 7;

export interface RetentionCutoffs {
  /** Delete safety events created before this (epoch ms). */
  safetyEvents: number;
  /** Clear excerpts of safety events created before this. */
  safetyExcerpts: number;
  /** Delete agent usage rows created before this. */
  agentUsage: number;
  /** Data export bundles created before this are expired and removed. */
  dataExports: number;
}

export function retentionCutoffs(now: number): RetentionCutoffs {
  return {
    safetyEvents: now - SAFETY_LOG_RETENTION_DAYS * DAY_MS,
    safetyExcerpts: now - SAFETY_EXCERPT_RETENTION_DAYS * DAY_MS,
    agentUsage: now - AGENT_USAGE_RETENTION_DAYS * DAY_MS,
    dataExports: now - DATA_EXPORT_LINK_TTL_DAYS * DAY_MS,
  };
}

/** Prefix of tombstone ids; never a valid `usr_<ULID>`. */
export const TOMBSTONE_PREFIX = "usr_deleted_";

/**
 * Stable pseudonym for a deleted user: the same user id always maps to the
 * same tombstone, so retained records (ledger, safety log, agent usage) still
 * group by person without naming them. One-way (SHA-256); the raw id is not
 * kept once deletion finishes.
 */
export async function tombstoneUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rolling:deleted-user:${userId}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${TOMBSTONE_PREFIX}${hex.slice(0, 32)}`;
}

export function isTombstone(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(TOMBSTONE_PREFIX);
}
