import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** apps/web static files by path (vitest.config.ts). */
      TEST_WEB_FILES: Record<string, string>;
    }
  }
}
