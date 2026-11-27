/** Public library queries (D1). Lives here so the drizzle-orm instance matches the schema. */
import { and, asc, count, eq, gt, like, or, type SQL } from "drizzle-orm";
import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import { publicItems, type PublicItem } from "../d1/schema";

export interface PublicItemsPage {
  items: PublicItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PublicItemsQuery {
  category?: string | null;
  sub?: string | null;
  q?: string | null;
  first: number;
  after?: string | null;
  /**
   * D-005: include mature items. Only for callers who are mature-allowed (active plan,
   * preference on, workspace flag on); every other caller and every public surface
   * leaves it off and gets exactly the non-mature set.
   */
  includeMature?: boolean;
}

/** Visibility filter: non-mature rows, or every row for a mature-allowed caller. */
function audience(includeMature: boolean | undefined): SQL[] {
  return includeMature ? [] : [eq(publicItems.mature, false)];
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

/** Public library listing. Mature items only with `includeMature` (mature-allowed callers, D-005). */
export async function listPublicItems(d1: AnyD1Database, query: PublicItemsQuery): Promise<PublicItemsPage> {
  const db = drizzle(d1);
  const where: SQL[] = audience(query.includeMature);
  if (query.category) where.push(eq(publicItems.category, query.category));
  if (query.sub) where.push(eq(publicItems.sub, query.sub));
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

/** Sub-categories with item counts for one category (non-mature items only, unless `includeMature`). */
export async function listPublicSubs(
  d1: AnyD1Database,
  category: string,
  opts: { includeMature?: boolean } = {},
): Promise<{ sub: string; count: number }[]> {
  const db = drizzle(d1);
  const rows = await db
    .select({ sub: publicItems.sub, count: count() })
    .from(publicItems)
    .where(and(eq(publicItems.category, category), ...audience(opts.includeMature)))
    .groupBy(publicItems.sub)
    .orderBy(asc(publicItems.sub));
  return rows.filter((r): r is { sub: string; count: number } => typeof r.sub === "string");
}

/** Category item counts (non-mature items only, unless `includeMature`). */
export async function listPublicCategoryCounts(
  d1: AnyD1Database,
  opts: { includeMature?: boolean } = {},
): Promise<{ category: string; count: number }[]> {
  const db = drizzle(d1);
  return db
    .select({ category: publicItems.category, count: count() })
    .from(publicItems)
    .where(and(...audience(opts.includeMature)))
    .groupBy(publicItems.category)
    .orderBy(asc(publicItems.category));
}

/** Whether a public item may be served on public surfaces (exists and is not mature). */
export async function isPublicItemServable(d1: AnyD1Database, id: string, category: string): Promise<boolean> {
  const db = drizzle(d1);
  const rows = await db
    .select({ id: publicItems.id })
    .from(publicItems)
    .where(and(eq(publicItems.id, id), eq(publicItems.category, category), eq(publicItems.mature, false)))
    .limit(1);
  return rows.length > 0;
}
