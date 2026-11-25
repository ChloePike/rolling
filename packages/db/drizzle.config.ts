import { defineConfig } from "drizzle-kit";

// Generates D1 migrations from the Drizzle schema into migrations/d1.
// Usage: pnpm --filter @rolling/db exec drizzle-kit generate
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/d1/schema.ts",
  out: "./migrations/d1",
});
