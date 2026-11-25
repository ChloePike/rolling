import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const SCREENS_DIR = here('../../../../docs/design/screens/');
const GEIST_WOFF2 = here('../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2');
const RUNTIME = here('./dc-runtime.js');

/**
 * Copy changes decided after the screens were drawn. The handoff (section 1)
 * names the nav item "Characters"; Main.dc.html still says "Character".
 */
export const NAV_LABEL_OVERRIDES: Record<string, string> = { Character: 'Characters' };

/**
 * Builds a self-contained HTML page that renders a `.dc.html` design screen in
 * the browser with the same self-hosted Geist font the app uses.
 */
export function buildDesignPage(screen: string, props: Record<string, unknown> = {}): string {
  const source = readFileSync(SCREENS_DIR + screen, 'utf8');
  const template = /<x-dc>([\s\S]*?)<\/x-dc>/.exec(source)?.[1];
  const scriptMatch = /<script type="text\/x-dc"[^>]*data-props='([^']*)'[^>]*>([\s\S]*?)<\/script>/.exec(source);
  if (!template || !scriptMatch) throw new Error(`Cannot parse design screen ${screen}`);
  const propSpec = JSON.parse(scriptMatch[1]!) as Record<string, { default?: unknown }>;
  const defaults = Object.fromEntries(
    Object.entries(propSpec)
      .filter(([k]) => !k.startsWith('$'))
      .map(([k, v]) => [k, v.default]),
  );
  const font = readFileSync(GEIST_WOFF2).toString('base64');
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>@font-face{font-family:'Geist';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2')}</style>
</head><body><div id="dc-root"></div>
<script>
window.__DC_TEMPLATE__ = ${json(template)};
window.__DC_SCRIPT__ = ${json(scriptMatch[2])};
window.__DC_PROPS__ = ${json({ ...defaults, ...props })};
window.__DC_NAV_LABELS__ = ${json(NAV_LABEL_OVERRIDES)};
</script>
<script>${readFileSync(RUNTIME, 'utf8')}</script>
</body></html>`;
}
