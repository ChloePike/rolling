/**
 * R2's S3 API for direct browser uploads (D-011): presigned `UploadPart` URLs
 * and `ListParts`, signed with SigV4 (`aws4fetch`). The R2 binding still
 * creates, completes and aborts the multipart upload; it cannot presign or
 * list the parts of an open upload, which is why the S3 API is used here.
 *
 * Config: secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; vars
 * `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` (the bucket bound as `MEDIA`).
 */
import { AwsClient } from "aws4fetch";

export const PART_URL_TTL_SECONDS = 3600;

export interface S3Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Null when the S3 credentials are not configured (dev fallback decides what to do). */
export function s3Config(env: Env): S3Config | null {
  const { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: bucket, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

function client(cfg: S3Config): AwsClient {
  return new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: "auto" });
}

/** `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>` with each key segment encoded. */
export function objectUrl(cfg: S3Config, key: string): URL {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}/${path}`);
}

/** Presigned `PUT` URL for one part; the browser sends the bytes straight to R2. */
export async function presignUploadPart(cfg: S3Config, key: string, uploadId: string, partNumber: number, expiresIn = PART_URL_TTL_SECONDS, datetime?: string): Promise<string> {
  const url = objectUrl(cfg, key);
  url.searchParams.set("partNumber", String(partNumber));
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await client(cfg).sign(url.toString(), { method: "PUT", aws: { signQuery: true, allHeaders: false, ...(datetime ? { datetime } : {}) } });
  return signed.url;
}

export interface ListedPart {
  n: number;
  size: number;
  etag: string;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]! : null;
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Parses one `ListPartsResult` page. ETags lose their quotes. */
export function parseListParts(xml: string): { parts: ListedPart[]; truncated: boolean; next: number | null } {
  const parts: ListedPart[] = [];
  for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const body = m[1]!;
    const n = Number(tag(body, "PartNumber"));
    const size = Number(tag(body, "Size"));
    const etag = unescapeXml(tag(body, "ETag") ?? "").replace(/^"|"$/g, "");
    if (Number.isInteger(n) && n > 0 && Number.isFinite(size) && etag) parts.push({ n, size, etag });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  const nextRaw = tag(xml, "NextPartNumberMarker");
  return { parts, truncated, next: nextRaw ? Number(nextRaw) : null };
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`R2 S3 request failed: ${status} ${code}`);
  }
}

/** Every part R2 has received for an open multipart upload (S3 `ListParts`, paginated). */
export async function listParts(cfg: S3Config, key: string, uploadId: string, fetcher: typeof fetch = fetch): Promise<ListedPart[]> {
  const aws = client(cfg);
  const all: ListedPart[] = [];
  let marker: number | null = null;
  for (let page = 0; page < 20; page++) {
    const url = objectUrl(cfg, key);
    url.searchParams.set("uploadId", uploadId);
    url.searchParams.set("max-parts", "1000");
    if (marker !== null) url.searchParams.set("part-number-marker", String(marker));
    const req = await aws.sign(url.toString(), { method: "GET" });
    const res = await fetcher(req);
    const text = await res.text();
    if (!res.ok) throw new S3Error(res.status, tag(text, "Code") ?? "Unknown");
    const parsed = parseListParts(text);
    all.push(...parsed.parts);
    if (!parsed.truncated || parsed.next === null) break;
    marker = parsed.next;
  }
  return all.sort((a, b) => a.n - b.n);
}
