/**
 * Staff roles and what each may do in the admin console (D-025). Checked on the
 * server for every admin route; the SPA only hides what the role cannot use.
 *
 * - `admin`: everything, including credits, plans, backups, staff and the
 *   restricted child-safety cases.
 * - `reviewer`: the review queue (safety, reports, appeals, DMCA), warnings,
 *   suspensions and content removal, and read access to users and workspaces.
 *   No money, no plans, no child-safety cases.
 */
export type StaffRole = 'admin' | 'reviewer';

export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'reviewer'];

export type StaffPermission =
  | 'view' // users, workspaces, ledgers, runs, safety events, metrics, status
  | 'review' // queue actions: dismiss, warn, suspend, delete content, DMCA, appeals
  | 'credits' // adjust credits, refund runs
  | 'plans' // comp plans through adminGrant
  | 'ops' // incident banner, backups and restore, breaker reset
  | 'staff' // add or remove staff
  | 'child_safety'; // restricted cases, evidence manifest, NCMEC packet

const PERMISSIONS: Record<StaffRole, ReadonlySet<StaffPermission>> = {
  admin: new Set<StaffPermission>(['view', 'review', 'credits', 'plans', 'ops', 'staff', 'child_safety']),
  reviewer: new Set<StaffPermission>(['view', 'review']),
};

export function isStaffRole(v: unknown): v is StaffRole {
  return v === 'admin' || v === 'reviewer';
}

export function staffCan(role: StaffRole | null | undefined, permission: StaffPermission): boolean {
  return !!role && PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: StaffRole): StaffPermission[] {
  return [...PERMISSIONS[role]];
}
