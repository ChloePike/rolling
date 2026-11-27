import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { LibraryCategoryKey, LibraryLicense } from '@rolling/core/library/types';
import { useMatureVisible } from '@/lib/media/RatedThumb';

/**
 * Public library client (D-004): read-only GraphQL at `/api/graphql` (D-003).
 * Items, categories and sub-categories with counts come from the server
 * (`publicItems`, `publicCategories`, `publicSubCategories`). Mature items
 * (D-005) come only for mature-allowed viewers (plan, workspace flag and the
 * preference on), counts included, with signed private image URLs; for anyone
 * else the server leaves them out and they are dropped again here if one ever
 * slips through. Query keys carry the audience, so turning the preference on
 * or off refetches. Non-mature image URLs are absolute on the media domain in
 * production (D-008) or `/api/media/...` in local dev and staging.
 *
 * Shared by the `/assets/public` page and the `@` picker's Public library tab.
 */

export interface PublicAngle {
  name: string;
  url: string;
  depthUrl: string | null;
}

export interface PublicItem {
  id: string;
  category: LibraryCategoryKey;
  sub: string | null;
  title: string;
  promptEn: string | null;
  tags: string[];
  assetId: string;
  license: LibraryLicense;
  /** Link back to the item on PoseWear. */
  source: string;
  /** Where the item comes from (D-004): CharaDB for CharaDB-hosted items, else the category's source. */
  attribution?: { name: string; url: string | null } | null;
  /** Cover image (first angle), or null when the item has no image in R2. Mature items: a signed private URL (D-008). */
  thumbUrl: string | null;
  /** Depth map of the cover angle (pose items). */
  depthUrl: string | null;
  angles: PublicAngle[];
  /** D-005: an 18+ item; only ever listed for mature-allowed viewers. */
  mature?: boolean;
}

export interface PublicFacet {
  key: string;
  count: number;
}

export interface PublicPage {
  items: PublicItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export const PAGE_SIZE = 24;

const ITEMS_QUERY = /* GraphQL */ `
  query PublicItems($category: String, $sub: String, $q: String, $first: Int, $after: String) {
    publicItems(category: $category, sub: $sub, q: $q, first: $first, after: $after) {
      edges { node { id category sub title promptEn tags assetId license source attribution { name url } thumbUrl depthUrl mature angles { name url depthUrl } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const CATEGORIES_QUERY = /* GraphQL */ `
  query PublicCategories { publicCategories { key count } }
`;
const SUBS_QUERY = /* GraphQL */ `
  query PublicSubCategories($category: String!) { publicSubCategories(category: $category) { key count } }
`;

const LICENSES: Record<string, LibraryLicense> = { FIRST_PARTY: 'first-party', CC0: 'cc0', MIT: 'mit' };

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Public library request failed (${res.status})`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length || !json.data) throw new Error(json.errors?.[0]?.message ?? 'Public library request failed');
  return json.data;
}

/**
 * Image URL as served: absolute http(s) (media domain) or root-relative
 * (`/api/media/...`). Anything else is dropped so cards fall back to glyphs.
 */
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return /^https?:\/\//i.test(url) ? url : null;
}

type RawItem = Omit<PublicItem, 'license' | 'thumbUrl' | 'depthUrl' | 'angles'> & {
  license: string;
  thumbUrl?: string | null;
  depthUrl?: string | null;
  angles?: Array<{ name: string; url: string; depthUrl?: string | null }> | null;
};

function toItem(raw: RawItem): PublicItem {
  return {
    ...raw,
    license: LICENSES[raw.license] ?? (raw.license as LibraryLicense),
    thumbUrl: mediaUrl(raw.thumbUrl),
    depthUrl: mediaUrl(raw.depthUrl),
    angles: (raw.angles ?? []).flatMap((a) => {
      const url = mediaUrl(a.url);
      return url ? [{ name: a.name, url, depthUrl: mediaUrl(a.depthUrl) }] : [];
    }),
  };
}

export async function fetchPublicItems(vars: {
  category?: string | null;
  sub?: string | null;
  q?: string;
  after?: string | null;
  first?: number;
  /** The viewer may see mature items (D-005); otherwise any that slip through are dropped. */
  mature?: boolean;
}): Promise<PublicPage> {
  const data = await graphql<{
    publicItems: { edges: Array<{ node: RawItem }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(ITEMS_QUERY, {
    category: vars.category ?? null,
    sub: vars.sub ?? null,
    q: vars.q || null,
    first: vars.first ?? PAGE_SIZE,
    after: vars.after ?? null,
  });
  const conn = data.publicItems;
  return {
    items: conn.edges.map((e) => toItem(e.node)).filter((i) => !i.mature || vars.mature === true),
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  };
}

/** Sub-categories, largest first (stable for ties). */
function byCount(facets: PublicFacet[]): PublicFacet[] {
  return facets.map((f, i) => [f, i] as const).sort((a, b) => b[0].count - a[0].count || a[1] - b[1]).map(([f]) => f);
}

export async function fetchPublicCategories(): Promise<PublicFacet[]> {
  return (await graphql<{ publicCategories: PublicFacet[] }>(CATEGORIES_QUERY)).publicCategories;
}

export async function fetchPublicSubCategories(category: string): Promise<PublicFacet[]> {
  return byCount((await graphql<{ publicSubCategories: PublicFacet[] }>(SUBS_QUERY, { category })).publicSubCategories);
}

const STALE = 5 * 60_000;

/** Paged items of one category (null: every category), optionally one sub-category and a search. */
export function usePublicItems(category: LibraryCategoryKey | null, opts: { sub?: string | null; q?: string; enabled?: boolean } = {}) {
  const sub = opts.sub ?? null;
  const q = opts.q ?? '';
  const mature = useMatureVisible();
  return useInfiniteQuery({
    queryKey: ['public-library', audienceKey(mature), 'items', category, sub, q],
    queryFn: ({ pageParam }) => fetchPublicItems({ category, sub, q, after: pageParam, mature }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasNextPage ? last.endCursor : undefined),
    staleTime: STALE,
    retry: 1,
    enabled: opts.enabled ?? true,
  });
}

/** Cache partition per audience (D-005): the two never share results. */
const audienceKey = (mature: boolean) => (mature ? 'mature' : 'general');

/** Categories with item counts (non-mature; mature included for mature-allowed viewers). Categories without items are absent or 0. */
export function usePublicCategories() {
  const mature = useMatureVisible();
  return useQuery({ queryKey: ['public-library', audienceKey(mature), 'categories'], queryFn: fetchPublicCategories, staleTime: STALE, retry: 1 });
}

export function usePublicSubCategories(category: LibraryCategoryKey) {
  const mature = useMatureVisible();
  return useQuery({ queryKey: ['public-library', audienceKey(mature), 'subs', category], queryFn: () => fetchPublicSubCategories(category), staleTime: STALE, retry: 1 });
}

/** Short card id, e.g. `pw_pose_full_single_P001` → `P001`. */
export function shortId(id: string): string {
  const tail = id.split('_').pop() ?? id;
  return tail.length > 8 ? tail.slice(0, 6).toUpperCase() : tail;
}
