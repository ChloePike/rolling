/**
 * Media URLs for API responses (D-008). Private media gets short-lived signed
 * URLs on the media host (`PRIVATE_MEDIA_BASE_URL`, empty = this Worker's
 * `/media/*` route until the media hostname exists). Non-mature public-library
 * objects use the public media base. Mature media is only signed for viewers
 * allowed to see it (D-005); everyone else gets `null`.
 */
import { SHARED_MEDIA_WS, keyBelongsTo, signMediaKey } from "@rolling/core/media";
import { publicMediaUrl } from "../routes/media";

/** Used only when ENVIRONMENT=development and no secret is set (local dev, tests). */
const DEV_SIGNING_KEY = "rolling-dev-media-signing-key";
export const DEFAULT_MEDIA_TTL_SECONDS = 3600;

export function mediaSigningKey(env: Env): string {
  if (env.MEDIA_SIGNING_KEY) return env.MEDIA_SIGNING_KEY;
  if (env.ENVIRONMENT === "development") return DEV_SIGNING_KEY;
  throw new Error("MEDIA_SIGNING_KEY is not configured");
}

export async function signMediaUrl(
  env: Env,
  key: string,
  opts: { workspaceId: string; expiresIn?: number; absolute?: boolean },
): Promise<string> {
  const base = env.PRIVATE_MEDIA_BASE_URL || (opts.absolute ? env.PUBLIC_APP_URL : "");
  return signMediaKey(key, {
    workspaceId: opts.workspaceId,
    expiresIn: opts.expiresIn ?? DEFAULT_MEDIA_TTL_SECONDS,
    secret: mediaSigningKey(env),
    baseUrl: base,
  });
}

export interface MediaRef {
  key: string;
  workspaceId: string | null;
  mature: boolean;
}

/** URL for one stored object as `viewer` may see it, or null. */
export async function mediaUrlFor(env: Env, ref: MediaRef, viewer: { mayViewMature: boolean }, expiresIn?: number): Promise<string | null> {
  if (ref.mature && !viewer.mayViewMature) return null;
  if (ref.key.startsWith("public/") && !ref.mature) return publicMediaUrl(ref.key, env.PUBLIC_MEDIA_BASE_URL);
  const ws = ref.workspaceId && keyBelongsTo(ref.key, ref.workspaceId) ? ref.workspaceId : SHARED_MEDIA_WS;
  if (!keyBelongsTo(ref.key, ws)) return null;
  return signMediaUrl(env, ref.key, { workspaceId: ws, expiresIn });
}

export interface AssetRow {
  id: string;
  workspace_id: string | null;
  kind: "image" | "video" | "audio" | "text";
  source: "mine" | "team" | "builtin" | "public" | "generated";
  name: string;
  r2_key: string;
  meta: string;
  license: string | null;
  project_id: string | null;
  created_by: string | null;
  created_at: number;
  status: "uploading" | "processing" | "ready" | "failed";
  mature: number;
  size: number | null;
  content_type: string | null;
}

export function assetMeta(row: Pick<AssetRow, "meta">): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(row.meta);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AssetView {
  id: string;
  kind: AssetRow["kind"];
  source: AssetRow["source"];
  name: string;
  status: AssetRow["status"];
  mature: boolean;
  size: number | null;
  contentType: string | null;
  license: string | null;
  projectId: string | null;
  createdBy: string | null;
  createdAt: number;
  /** Signed or public URL; null while uploading or when the viewer may not see mature media. */
  url: string | null;
  thumbUrl: string | null;
  waveformUrl: string | null;
  meta: { width?: number; height?: number; durationSec?: number; processing?: string; tags?: string[] };
}

export async function assetView(env: Env, row: AssetRow, viewer: { mayViewMature: boolean }): Promise<AssetView> {
  const meta = assetMeta(row);
  const mature = row.mature === 1;
  const ref = (key: unknown) =>
    typeof key === "string" && row.status !== "uploading" ? mediaUrlFor(env, { key, workspaceId: row.workspace_id, mature }, viewer) : Promise.resolve(null);
  const [url, thumbUrl, waveformUrl] = await Promise.all([
    ref(row.r2_key),
    ref(meta.thumbKey ?? (row.kind === "image" ? row.r2_key : undefined)),
    ref(meta.waveformKey),
  ]);
  const pick = <T>(k: string, t: string) => (typeof meta[k] === t ? (meta[k] as T) : undefined);
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    name: row.name,
    status: row.status,
    mature,
    size: row.size,
    contentType: row.content_type,
    license: row.license,
    projectId: row.project_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    url,
    thumbUrl,
    waveformUrl,
    meta: {
      width: pick<number>("width", "number"),
      height: pick<number>("height", "number"),
      durationSec: pick<number>("durationSec", "number"),
      processing: pick<string>("processing", "string"),
      tags: Array.isArray(meta.tags) ? (meta.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
    },
  };
}
