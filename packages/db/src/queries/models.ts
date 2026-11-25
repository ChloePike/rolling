/** Model catalog queries (D1, D-002). Lives here so the drizzle-orm instance matches the schema. */
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import {
  models,
  subscriptions,
  userPrefs,
  workspaceMembers,
  workspaces,
  type ModelRow,
  type NewModelRow,
} from "../d1/schema";

export type ModelKind = ModelRow["kind"];

/** All synced models, optionally of one kind, ordered by id. */
export async function listModelRows(d1: AnyD1Database, query: { kind?: ModelKind | null } = {}): Promise<ModelRow[]> {
  const db = drizzle(d1);
  const rows = db.select().from(models);
  return query.kind
    ? rows.where(eq(models.kind, query.kind)).orderBy(asc(models.id))
    : rows.orderBy(asc(models.id));
}

export async function getModelRow(d1: AnyD1Database, id: string): Promise<ModelRow | null> {
  const db = drizzle(d1);
  return (await db.select().from(models).where(eq(models.id, id)).get()) ?? null;
}

/** Inserts or replaces the given rows in one batch (D1 runs a batch as a transaction). */
export async function upsertModels(d1: AnyD1Database, rows: readonly NewModelRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = drizzle(d1);
  const statements = rows.map((row) =>
    db
      .insert(models)
      .values(row)
      .onConflictDoUpdate({
        target: models.id,
        set: {
          kind: sql`excluded.kind`,
          data: sql`excluded.data`,
          price: sql`excluded.price`,
          hidden: sql`excluded.hidden`,
          mature: sql`excluded.mature`,
          syncedAt: sql`excluded.synced_at`,
        },
      }),
  );
  await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
}

/** Deletes models last seen before `cutoff` (epoch ms). Returns the deleted ids. */
export async function deleteModelsSeenBefore(d1: AnyD1Database, cutoff: number): Promise<string[]> {
  const db = drizzle(d1);
  const stale = await db.select({ id: models.id }).from(models).where(lt(models.syncedAt, cutoff));
  if (stale.length === 0) return [];
  const ids = stale.map((r) => r.id);
  await db.delete(models).where(inArray(models.id, ids));
  return ids;
}

/**
 * D-005 visibility: the user turned on mature content and belongs to a
 * workspace that allows it and has an active paid subscription.
 */
export async function userMayViewMatureModels(d1: AnyD1Database, userId: string, now: number): Promise<boolean> {
  const db = drizzle(d1);
  const prefs = await db.select({ on: userPrefs.matureContent }).from(userPrefs).where(eq(userPrefs.userId, userId)).get();
  if (!prefs?.on) return false;
  const row = await db
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .innerJoin(subscriptions, eq(subscriptions.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaces.matureAllowed, true),
        eq(subscriptions.status, "active"),
        gt(subscriptions.currentPeriodEnd, now),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}
