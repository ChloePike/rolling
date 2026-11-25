import type { Page } from '@playwright/test';

type Point = { resolution: string | null; seconds: number | null; credits: number };

function model(
  id: string,
  kind: 'image' | 'video' | 'chat',
  name: string,
  credits: Point[],
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind,
    name,
    tags: [],
    default: false,
    auto: kind === 'video',
    mature: false,
    matureOnly: false,
    requiresIdentitySafety: false,
    operations: [],
    seconds: kind === 'video' ? { min: 5, max: 30 } : null,
    defaultSeconds: kind === 'video' ? 5 : null,
    resolutions: kind === 'video' ? ['480p', '720p', '1080p'] : kind === 'image' ? ['1K', '2K', '4K'] : [],
    defaultResolution: kind === 'video' ? '720p' : kind === 'image' ? '2K' : null,
    ratios: ['9:16', '16:9', '1:1'],
    audio: false,
    lipSync: false,
    credits,
    ...extra,
  };
}

const perSecond = (base720: number) =>
  (['480p', '720p', '1080p'] as const).flatMap((r, i) =>
    [5, 10, 15, 30].map((s) => ({ resolution: r, seconds: s, credits: Math.round([0.5, 1, 1.75][i]! * base720 * (s / 5)) })),
  );

/**
 * Catalog fixture for `GET /api/models` (shape of `CatalogModel` in
 * src/lib/models). Names and prices reproduce Main.dc.html: Seedance 2.5
 * 720p 5s = 8 credits, Seedream 5.0 Pro 2K = 1 credit per image (2 images = 2),
 * the lip-sync model = 12 credits.
 */
export const MODELS_FIXTURE = [
  model('deepseek/deepseek-v4.1-flash', 'chat', 'DeepSeek', [], { default: true }),
  model('bytedance/seedream-5.0-pro', 'image', 'Seedream 5.0 Pro', [
    { resolution: '1K', seconds: null, credits: 1 },
    { resolution: '2K', seconds: null, credits: 1 },
    { resolution: '4K', seconds: null, credits: 2 },
  ], { default: true, tags: ['Native 2K', '4K upscale'] }),
  model('bytedance/seedream-5.0-lite', 'image', 'Seedream 5.0 Lite', [{ resolution: '2K', seconds: null, credits: 1 }]),
  model('bytedance/seedance-2.5', 'video', 'Seedance 2.5', perSecond(8), { default: true, tags: ['Omni reference', 'First & last frame'] }),
  model('minimax/minimax-h3', 'video', 'MiniMax H3', perSecond(6)),
  model('alibaba/wan3.0', 'video', 'Wan 3.0', perSecond(7)),
  model('lumina/minimax-h3-lipsync', 'video', 'MiniMax H3', [{ resolution: null, seconds: null, credits: 12 }], { lipSync: true, auto: false }),
];

/** Serves the catalog fixture for every `/api/models` request of the page. */
export async function routeModels(page: Page) {
  await page.route('**/api/models**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    const models = kind ? MODELS_FIXTURE.filter((m) => m.kind === kind) : MODELS_FIXTURE;
    return route.fulfill({ json: { models } });
  });
}
