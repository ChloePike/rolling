import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAV_LABEL_OVERRIDES, SCREENS_DIR } from '../../support/design';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const GEIST_WOFF2 = here('../../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2');
const RUNTIME = here('./dc-runtime-imports.js');

interface ComponentDef {
  template: string;
  script: string;
  defaults: Record<string, unknown>;
}

function parse(screen: string): ComponentDef & { imports: string[] } {
  const source = readFileSync(`${SCREENS_DIR}${screen}.dc.html`, 'utf8');
  const template = /<x-dc>([\s\S]*?)<\/x-dc>/.exec(source)?.[1];
  const m = /<script type="text\/x-dc"[^>]*data-props='([^']*)'[^>]*>([\s\S]*?)<\/script>/.exec(source);
  if (!template || !m) throw new Error(`Cannot parse design screen ${screen}`);
  const spec = JSON.parse(m[1]!) as Record<string, { default?: unknown }>;
  const defaults = Object.fromEntries(
    Object.entries(spec)
      .filter(([k]) => !k.startsWith('$'))
      .map(([k, v]) => [k, v.default]),
  );
  const imports = Array.from(template.matchAll(/<dc-import name="([^"]+)"/g), (x) => x[1]!);
  return { template, script: m[2]!, defaults, imports };
}

/**
 * Builds a self-contained page that renders a `.dc.html` screen (base or state
 * wrapper) with every component it imports, using the app's Geist font.
 */
export function buildToolDesignPage(screen: string, props: Record<string, unknown> = {}): string {
  const components: Record<string, ComponentDef> = {};
  const queue = [screen];
  while (queue.length) {
    const name = queue.shift()!;
    if (components[name]) continue;
    const { imports, ...def } = parse(name);
    components[name] = def;
    queue.push(...imports);
  }
  const font = readFileSync(GEIST_WOFF2).toString('base64');
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>@font-face{font-family:'Geist';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2')}</style>
</head><body><div id="dc-root"></div>
<script>
window.__DC_COMPONENTS__ = ${json(components)};
window.__DC_MAIN__ = ${json(screen)};
window.__DC_PROPS__ = ${json(props)};
window.__DC_NAV_LABELS__ = ${json(NAV_LABEL_OVERRIDES)};
</script>
<script>${readFileSync(RUNTIME, 'utf8')}</script>
</body></html>`;
}
