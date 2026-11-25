/** Public library queries (D1). Lives here so the drizzle-orm instance matches the schema. */
import { and, asc, eq, gt, like, or, type SQL } from "drizzle-orm";
import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import { publicItems, type PublicItem } from "../d1/schema";

export interface PublicItemsPage {
  items: PublicItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PublicItemsQuery {
  category?: string | null;
  q?: string | null;
  first: number;
  after?: string | null;
}

/** Opaque keyset cursor over (sort, id). */
export function encodeCursor(item: Pick<PublicItem, "sort" | "id">): string {
  return btoa(JSON.stringify([item.sort, item.id]));
}

export function decodeCursor(cursor: string): { sort: number; id: string } | null {
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string") return { sort: v[0], id: v[1] };
  } catch {
    // Fall through.
  }
  return null;
}

/** Public library listing. Mature items are never returned (public surface, D-005). */
export async function listPublicItems(d1: AnyD1Database, query: PublicItemsQuery): Promise<PublicItemsPage> {
  const db = drizzle(d1);
  const where: SQL[] = [eq(publicItems.mature, false)];
  if (query.category) where.push(eq(publicItems.category, query.category));
  if (query.q) {
    const pattern = `%${query.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(or(like(publicItems.title, pattern), like(publicItems.promptEn, pattern))!);
  }
  if (query.after) {
    const cur = decodeCursor(query.after);
    if (cur) {
      where.push(
        or(gt(publicItems.sort, cur.sort), and(eq(publicItems.sort, cur.sort), gt(publicItems.id, cur.id)))!,
      );
    }
  }
  const rows = await db
    .select()
    .from(publicItems)
    .where(and(...where))
    .orderBy(asc(publicItems.sort), asc(publicItems.id))
    .limit(query.first + 1);
  const items = rows.slice(0, query.first);
  const last = items.at(-1);
  return { items, hasNextPage: rows.length > query.first, endCursor: last ? encodeCursor(last) : null };
}
