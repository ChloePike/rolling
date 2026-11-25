import type { Page, Route } from '@playwright/test';

/**
 * GraphQL mock for the public library (apps/api/src/graphql): `publicItems`,
 * `publicCategories` and `publicSubCategories`, so the library page and the
 * `@` picker are deterministic without an API. Counts follow the staging
 * import (2026-11-25); hairstyles have no items (CharaDB images are excluded
 * from R2, D-004).
 */

export type PublicNode = {
  id: string;
  category: string;
  sub: string | null;
  title: string;
  promptEn: string | null;
  tags: string[];
  assetId: string;
  license: string;
  source: string;
  thumbUrl?: string | null;
  depthUrl?: string | null;
  angles?: Array<{ name: string; url: string; depthUrl: string | null }>;
  mature?: boolean;
};

export const CATEGORY_COUNTS: Record<string, number> = {
  pose: 98,
  pose_depth: 98,
  portrait: 1499,
  expression: 95,
  outfit: 1067,
  outfit_anime: 983,
  outfit_historical: 57,
  scene: 64,
  lighting: 50,
  prop: 32,
  furniture: 41,
};

export const SUB_COUNTS: Record<string, Array<[string, number]>> = {
  pose: [['cute', 25], ['sitting', 14], ['standing', 14], ['kneeling', 10], ['lying-down', 9], ['side-sitting', 8], ['squatting', 6], ['leaning-forward', 6], ['leaning-back', 3], ['twisting', 3]],
  portrait: [['front', 893], ['lifestyle', 606]],
  expression: [['happy', 8], ['laughing', 7], ['angry', 8]],
  outfit: [['spring', 215], ['summer', 254], ['autumn', 243], ['winter', 253], ['party', 48], ['swimsuit', 54]],
  scene: [['indoor', 14], ['city', 12], ['nature', 17], ['historical-and-fantasy', 15], ['studio', 6]],
};

export interface PublicCall {
  op: 'items' | 'categories' | 'subs';
  variables: Record<string, unknown>;
}

/**
 * Routes `/api/graphql`. `items(category)` returns the nodes for a category
 * (null: every category); `sub` and `q` filter them like the server does.
 */
export async function mockPublicLibrary(page: Page, items: (category: string | null) => PublicNode[], calls: PublicCall[] = []) {
  await page.route('**/api/graphql', async (route: Route) => {
    const body = route.request().postDataJSON() as { query: string; variables?: Record<string, unknown> };
    const v = body.variables ?? {};
    if (body.query.includes('publicCategories')) {
      calls.push({ op: 'categories', variables: v });
      return route.fulfill({ json: { data: { publicCategories: Object.entries(CATEGORY_COUNTS).map(([key, count]) => ({ key, count })) } } });
    }
    if (body.query.includes('publicSubCategories')) {
      calls.push({ op: 'subs', variables: v });
      const subs = SUB_COUNTS[String(v.category)] ?? [];
      return route.fulfill({ json: { data: { publicSubCategories: subs.map(([key, count]) => ({ key, count })) } } });
    }
    calls.push({ op: 'items', variables: v });
    const category = typeof v.category === 'string' ? v.category : null;
    const q = typeof v.q === 'string' ? v.q.toLowerCase() : '';
    const nodes = items(category)
      .filter((n) => !v.sub || n.sub === v.sub)
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .map((n) => ({ thumbUrl: null, depthUrl: null, angles: [], ...n }));
    return route.fulfill({
      json: { data: { publicItems: { edges: nodes.map((node) => ({ cursor: node.id, node })), pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
  });
}

/** A 2x2 PNG served for thumbnail URLs in tests. */
export const PNG_2X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMIDU0AIgYIBQAc+gQpTZDTggAAAABJRU5ErkJggg==',
  'base64',
);
