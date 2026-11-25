/**
 * Downloads of private media (results, assets, exports) through the shared
 * transfer queue (D-011): the URL is a short-lived signed media URL from
 * `GET /api/assets/:id` (D-008), refreshed through the same call when it
 * expires mid-download.
 */
import { download } from '@/lib/transfers';
import { apiFetch } from './backend';

interface AssetResponse {
  asset: { id: string; name: string; url: string | null; contentType?: string | null };
}

/** A fresh signed URL for an asset the viewer may see, or null (mature for this viewer, deleted). */
export async function signedAssetUrl(assetId: string): Promise<string | null> {
  const r = await apiFetch<AssetResponse>(`/assets/${encodeURIComponent(assetId)}`);
  return r.asset.url;
}

const EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'download';
}

/** Queues the asset's download; resolves once it was handed over (or false when it cannot be signed). */
export async function downloadAsset(assetId: string, title: string): Promise<boolean> {
  const r = await apiFetch<AssetResponse>(`/assets/${encodeURIComponent(assetId)}`);
  if (!r.asset.url) return false;
  const ext = (r.asset.contentType && EXT[r.asset.contentType]) || /\.([a-z0-9]{2,4})$/i.exec(r.asset.name)?.[1] || 'bin';
  await download(r.asset.url, { filename: `${safeName(title)}.${ext}`, refreshUrl: () => signedAssetUrl(assetId) });
  return true;
}
