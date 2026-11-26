/**
 * Writes the built-in templates (`@rolling/core/templates` BUILTIN_TEMPLATES)
 * as a D1 seed migration (0016, then 0019 with the Home inspiration set). Re-run
 * after changing them and write the output to a new migration when the latest
 * seed is already applied somewhere:
 *
 *   pnpm --filter @rolling/api exec tsx scripts/seed-templates.ts [out.sql] [migration name]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtinTemplatesSql } from "@rolling/core/templates";

const out = process.argv[2] ?? fileURLToPath(new URL("../../../packages/db/migrations/d1/0019_seed_inspiration_templates.sql", import.meta.url));
const name = process.argv[3] ?? "0019_seed_inspiration_templates";
const header = [
  `-- Migration ${name}: built-in templates (workspace_id NULL), generated from`,
  "-- packages/core/src/templates/builtin.ts by apps/api/scripts/seed-templates.ts. Do not edit by hand.",
  "",
].join("\n");
writeFileSync(out, header + builtinTemplatesSql());
console.log(`wrote ${out}`);
