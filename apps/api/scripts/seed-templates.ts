/**
 * Writes the built-in templates (`@rolling/core/templates` BUILTIN_TEMPLATES)
 * as D1 migration 0016. Re-run after changing them and add a new migration
 * with the output when 0016 is already applied somewhere:
 *
 *   pnpm --filter @rolling/api exec tsx scripts/seed-templates.ts [out.sql]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtinTemplatesSql } from "@rolling/core/templates";

const out = process.argv[2] ?? fileURLToPath(new URL("../../../packages/db/migrations/d1/0016_seed_templates.sql", import.meta.url));
const header = [
  "-- Migration 0016_seed_templates: built-in templates (workspace_id NULL), generated from",
  "-- packages/core/src/templates/builtin.ts by apps/api/scripts/seed-templates.ts. Do not edit by hand.",
  "",
].join("\n");
writeFileSync(out, header + builtinTemplatesSql());
console.log(`wrote ${out}`);
