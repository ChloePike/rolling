#!/usr/bin/env node
/**
 * Copies the model provider marks the app uses from `@lobehub/icons-static-svg`
 * (MIT) into `public/model-icons/`. Run after bumping the package:
 *   pnpm --filter @rolling/web exec node scripts/copy-model-icons.mjs
 * Keep BRANDS in sync with `src/lib/modelIcons/index.ts`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANDS = ['bytedance', 'minimax', 'alibaba', 'qwen', 'grok', 'claude', 'openai', 'deepseek', 'zhipu'];

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@lobehub/icons-static-svg/package.json'));
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const out = join(here, '..', 'public', 'model-icons');
mkdirSync(out, { recursive: true });

for (const brand of BRANDS) {
  for (const file of [`${brand}.svg`, `${brand}-color.svg`]) {
    const src = join(pkgDir, 'icons', file);
    if (!existsSync(src)) {
      if (file.endsWith('-color.svg')) continue; // Some marks are mono only (OpenAI, Grok).
      throw new Error(`Missing ${file} in @lobehub/icons-static-svg@${version}`);
    }
    copyFileSync(src, join(out, file));
    console.log(`copied ${file}`);
  }
}
console.log(`@lobehub/icons-static-svg@${version} → public/model-icons`);
