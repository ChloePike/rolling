#!/usr/bin/env node
/**
 * After `vite build`: writes the legal pages as static HTML (`dist/privacy.html`,
 * `terms.html`, `acceptable-use.html`, `subprocessors.html`) from legal/*.md via
 * src/features/legal/staticHtml.ts, so they read without JavaScript. The Worker
 * serves them as plain files (apps/api/src/lib/r2Static.ts: `/privacy` → `privacy.html`).
 * Written after the build so the service worker does not precache them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
/** Output directory: `dist` by default, or the first argument (resolved from the current directory). */
const outDir = process.argv[2] ? resolve(process.argv[2]) : r('../dist');
mkdirSync(outDir, { recursive: true });
const { module } = await runnerImport(r('../src/features/legal/staticHtml.ts'), {
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@messages': r('../../../messages'), '@legal': r('../../../legal') } },
});
for (const [file, html] of Object.entries(module.staticLegalFiles())) {
  writeFileSync(join(outDir, file), html);
  console.log(`prerendered ${file} (${html.length} bytes)`);
}
