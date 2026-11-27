/**
 * Private R2 prefixes that no media route ever serves (D-027, D-030):
 * `evidence/` holds locked child-safety evidence (bucket lock rule, staff
 * access only through the Cloudflare dashboard by the designated custodian),
 * `backups/` holds nightly Durable Object dumps.
 */
export const EVIDENCE_PREFIX = "evidence/";
export const BACKUP_PREFIX = "backups/";

export function isRestrictedKey(key: string): boolean {
  const k = key.replace(/^\/+/, "");
  return k.startsWith(EVIDENCE_PREFIX) || k.startsWith(BACKUP_PREFIX);
}
