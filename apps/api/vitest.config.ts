import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations/d1", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // The main wrangler config works in the pool, Container binding included
      // (containers are not started; FfmpegRenderer is only bound).
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir), EMAIL_LOG: "off", MEDIA_CONTAINER: "off", GENERATE_RETRY_BACKOFF: "0,0,0" },
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
