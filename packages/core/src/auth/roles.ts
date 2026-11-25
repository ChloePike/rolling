/** Workspace roles (PRD rule 7). Owner > editor > viewer. */
export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles an invite can grant. Ownership is given by changing a member's role. */
export const INVITE_ROLES = ['editor', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True when `role` is at least `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
