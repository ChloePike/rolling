import { useInfiniteQuery } from '@tanstack/react-query';
import type { LibraryCategoryKey, LibraryLicense } from '@rolling/core/library/types';

/**
 * Public library client: read-only GraphQL at `/api/graphql` (D-003),
 * `publicItems(category, q, first, after)`. Mature items are excluded by the
 * server (D-005) and dropped again here if one ever slips through.
 */

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
  /**
   * Thumbnail URL. The GraphQL schema does not expose one yet (R2 media route
   * comes later); cards fall back to the category glyph until it does.
   */
  thumbUrl?: string | null;
  mature?: boolean;
}

interface Page {
  items: PublicItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const QUERY = /* GraphQL */ `
  query PublicItems($category: String, $q: String, $first: Int, $after: String) {
    publicItems(category: $category, q: $q, first: $first, after: $after) {
      edges { node { id category sub title promptEn tags assetId license source } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const LICENSES: Record<string, LibraryLicense> = { FIRST_PARTY: 'first-party', CC0: 'cc0', MIT: 'mit' };

interface Raw {
  data?: {
    publicItems: {
      edges: Array<{ node: Omit<PublicItem, 'license'> & { license: string } }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

export const PAGE_SIZE = 24;

export async function fetchPublicItems(vars: { category: string; q?: string; after?: string | null; first?: number }): Promise<Page> {
  const res = await fetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: QUERY,
      variables: { category: vars.category, q: vars.q || null, first: vars.first ?? PAGE_SIZE, after: vars.after ?? null },
    }),
  });
  if (!res.ok) throw new Error(`Public library request failed (${res.status})`);
  const json = (await res.json()) as Raw;
  if (json.errors?.length || !json.data) throw new Error(json.errors?.[0]?.message ?? 'Public library request failed');
  const conn = json.data.publicItems;
  return {
    items: conn.edges
      .map((e) => ({ ...e.node, license: LICENSES[e.node.license] ?? (e.node.license as LibraryLicense) }))
      .filter((i) => !i.mature),
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  };
}

export function usePublicItems(category: LibraryCategoryKey, q: string) {
  return useInfiniteQuery({
    queryKey: ['public-library', category, q],
    queryFn: ({ pageParam }) => fetchPublicItems({ category, q, after: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasNextPage ? last.endCursor : undefined),
    staleTime: 5 * 60_000,
  });
}
