/**
 * Preview covers of the built-in templates (`@rolling/core/templates`
 * `templateCoverSvg`): renders each cover as SVG, rasterizes it to PNG with
 * ffmpeg (librsvg), and with `--upload` writes it to
 * `public/templates/<id>/cover.png` through the Cloudflare R2 REST API.
 * Migration 0017 points the templates at those keys (`meta.coverKey`); the API
 * builds `coverUrl` with the public media URL builder (D-008).
 *
 *   pnpm --filter @rolling/api exec tsx scripts/template-covers.ts [--out dir] [--upload]
 *     [--account <id>] [--bucket rolling-media-staging]
 *
 * Only `public/templates/*` keys are ever written. The token (`CF_R2_TOKEN`,
 * else `CLOUDFLARE_API_TOKEN`) needs R2 write access; behind a proxy that injects
 * it, pass its placeholder (e.g. `CF_R2_TOKEN=proxy-injected NODE_USE_ENV_PROXY=1`:
 * Node's fetch uses HTTPS_PROXY only with that flag).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TEMPLATES, templateCoverKey, templateCoverSvg } from "@rolling/core/templates";

const DEFAULT_ACCOUNT = "e2ed20c61e6c1ce394300a753734eff9";
const DEFAULT_BUCKET = "rolling-media-staging";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = arg("out") ?? join(tmpdir(), "rolling-template-covers");
const upload = process.argv.includes("--upload");
const account = arg("account") ?? DEFAULT_ACCOUNT;
const bucket = arg("bucket") ?? DEFAULT_BUCKET;
mkdirSync(out, { recursive: true });

async function put(key: string, body: Uint8Array): Promise<void> {
  if (!key.startsWith("public/templates/")) throw new Error(`Refusing to write ${key}: only public/templates/* keys`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${process.env.CF_R2_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? ""}`, "content-type": "image/png" },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status} ${(await res.text()).slice(0, 300)}`);
}

for (const t of BUILTIN_TEMPLATES) {
  const svg = join(out, `${t.id}.svg`);
  const png = join(out, `${t.id}.png`);
  writeFileSync(svg, templateCoverSvg(t));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", svg, "-frames:v", "1", png]);
  const key = templateCoverKey(t.id);
  if (upload) {
    await put(key, readFileSync(png));
    console.log(`uploaded ${key} (${bucket})`);
  } else console.log(`wrote ${png} (→ ${key})`);
}
