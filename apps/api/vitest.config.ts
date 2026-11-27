import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const migrationsDir = r("../../packages/db/migrations/d1");

/**
 * The web build's static files as the deploy uploads them to R2 (`_web/`): the real
 * index.html and the build-time legal pages (apps/web/scripts/prerender-legal.mjs),
 * for test/legal-routes.test.ts. Generated here (Node) because the Workers pool has no fs.
 */
function staticWebFiles(): Record<string, string> {
  const out = r("./node_modules/.cache/static-web");
  execFileSync(process.execPath, [r("../web/scripts/prerender-legal.mjs"), out], { stdio: "ignore" });
  const files: Record<string, string> = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(`${out}/${f}`, "utf8")]));
  files["index.html"] = readFileSync(r("../web/index.html"), "utf8");
  for (const f of ["robots.txt", "sitemap.xml"]) files[f] = readFileSync(r(`../web/public/${f}`), "utf8");
  return files;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // The main wrangler config works in the pool, Container binding included
      // (containers are not started; FfmpegRenderer is only bound).
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir), TEST_WEB_FILES: staticWebFiles(), EMAIL_LOG: "off", MEDIA_CONTAINER: "off", GENERATE_RETRY_BACKOFF: "0,0,0", RESULT_REVIEW: "off" },
        // Deliver emails at once in tests (wrangler.jsonc batches for 10 s).
        queueConsumers: {
          "rolling-dev-notify-email": { maxBatchSize: 20, maxBatchTimeout: 0, maxRetries: 2 },
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
