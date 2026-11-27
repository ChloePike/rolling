/**
 * Build-time static HTML for the legal pages (D-016), so `/privacy`, `/terms`,
 * `/acceptable-use` and `/subprocessors` carry the full text without
 * JavaScript (Google's OAuth verification reads `/privacy` without running
 * scripts). `scripts/prerender-legal.mjs` writes `dist/<doc>.html` after the
 * Vite build; the Worker serves them as plain files (no SSR, no hydration).
 * Same Markdown parser as the SPA's LegalPage; colors are the design tokens.
 */
import tokensCss from '../../../../../packages/ui/tokens.css?raw';
import legal from '@messages/en/legal.json';
import shell from '@messages/en/shell.json';
import { LEGAL_DOCS, legalBlocks, type LegalDocId } from './docs';
import { plainText, type Block, type Inline } from './markdown';

export const SITE_ORIGIN = 'https://rolling.actor';

const msg = { ...legal, ...shell } as Record<string, string>;

/**
 * D-023: "The English version governs" in each translated locale. The static pages run no script
 * (Google reads them without JavaScript), so one note lists every translation, each in its language.
 */
const localeLegal = import.meta.glob<Record<string, string>>(['@messages/*/legal.json', '!@messages/en/legal.json'], { import: 'default', eager: true });
export function governsNotes(): string {
  const lines = Object.entries(localeLegal)
    .map(([path, m]) => [path.split('/').at(-2)!, m['legal.englishGoverns']] as const)
    .filter(([, text]) => !!text)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, text]) => `<p lang="${escapeHtml(locale)}">${escapeHtml(text!)}</p>`);
  return lines.length ? `<div class="note governs" role="note">${lines.join('')}</div>` : '';
}
const APP = msg['app.name']!;

const TOKENS = [
  'c-bg', 'c-surface-1', 'c-surface-2', 'c-border', 'c-text-1', 'c-text-2', 'c-text-3',
  'c-link', 'c-brand', 'c-warning-soft', 'c-warning-text', 'c-header-bg', 'font-sans', 'fs-page', 'r-input',
];

/** `--name:value` declarations of `TOKENS` in one CSS block. */
function declarations(block: string): string {
  return TOKENS.map((t) => block.match(new RegExp(`--${t}:([^;]+);`))?.[0])
    .filter(Boolean)
    .join('');
}

/** The dark defaults (first `:root` block) and the system-light overrides of tokens.css. */
export function tokenCss(css: string = tokensCss): string {
  const dark = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
  const lightStart = css.indexOf('@media (prefers-color-scheme:light)');
  const light = css.slice(lightStart, css.indexOf('}', lightStart));
  return `:root{color-scheme:dark;${declarations(dark)}}@media (prefers-color-scheme:light){:root{color-scheme:light;${declarations(light)}}}`;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:var(--c-bg);color:var(--c-text-2);font:15px/1.65 var(--font-sans)}
a{color:var(--c-link);text-underline-offset:2px}
.top{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:14px 32px;border-bottom:1px solid var(--c-border);background:var(--c-header-bg)}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--c-text-1);text-decoration:none}
.nav{display:flex;gap:4px;flex-wrap:wrap}
.nav a{padding:6px 10px;border-radius:var(--r-input);font-size:13px;color:var(--c-text-3);text-decoration:none}
.nav a[aria-current=page]{color:var(--c-text-1);background:var(--c-surface-2)}
.layout{display:grid;grid-template-columns:220px minmax(0,720px);gap:56px;justify-content:center;padding:40px 32px 64px}
.toc{position:sticky;top:24px;align-self:start;font-size:13px}
.toc p{margin:0 0 10px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--c-text-3)}
.toc ol{list-style:none;margin:0;padding:0}
.toc a{display:block;padding:4px 0;color:var(--c-text-3);text-decoration:none}
h1,h2,h3,h4,strong{color:var(--c-text-1)}
h1{margin:0 0 20px;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.02em}
h2{margin:44px 0 12px;font-size:20px;line-height:1.3}
h3{margin:28px 0 8px;font-size:16px}
h4{margin:20px 0 6px;font-size:15px}
p,ul,ol{margin:0 0 14px}
li{margin:0 0 6px}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border-radius:4px;background:var(--c-surface-2);color:var(--c-text-1)}
mark{padding:0 3px;border-radius:3px;background:var(--c-warning-soft);color:var(--c-warning-text)}
.governs{font-size:13px;line-height:1.5}.governs p{margin:0}
.note{margin:0 0 24px;padding:12px 16px;border:1px solid var(--c-border);border-radius:var(--r-input);background:var(--c-surface-1)}
.table{margin:0 0 18px;overflow-x:auto;border:1px solid var(--c-border);border-radius:var(--r-input)}
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.5}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--c-border)}
th{background:var(--c-surface-1);color:var(--c-text-1)}
tr:last-child td{border-bottom:0}
hr{border:0;border-top:1px solid var(--c-border);margin:32px 0}
.foot{display:flex;gap:16px;flex-wrap:wrap;padding:24px 32px 40px;border-top:1px solid var(--c-border);font-size:13px;color:var(--c-text-3)}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,720px);gap:24px;padding:24px 20px 56px}.toc{position:static}.top,.foot{padding-left:20px;padding-right:20px}}
@media print{.top,.toc,.foot{display:none}.layout{display:block;padding:0}}
`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inlines(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return n.v === '\n' ? '<br>' : escapeHtml(n.v);
        case 'strong':
          return `<strong>${inlines(n.c)}</strong>`;
        case 'em':
          return `<em>${inlines(n.c)}</em>`;
        case 'code':
          return `<code>${escapeHtml(n.v)}</code>`;
        case 'link': {
          const external = /^https?:\/\//.test(n.href);
          return `<a href="${escapeHtml(n.href)}"${external ? ' rel="noopener noreferrer"' : ''}>${inlines(n.c)}</a>`;
        }
        case 'placeholder':
          return `<mark data-placeholder>${escapeHtml(n.v)}</mark>`;
      }
    })
    .join('');
}

export function blocksHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'heading':
          return `<h${b.level} id="${b.id}">${inlines(b.c)}</h${b.level}>`;
        case 'p':
          return `<p>${inlines(b.c)}</p>`;
        case 'ul':
        case 'ol':
          return `<${b.t}>${b.items.map((i) => `<li>${inlines(i)}</li>`).join('')}</${b.t}>`;
        case 'quote':
          return `<div class="note" role="note">${blocksHtml(b.c)}</div>`;
        case 'table':
          return `<div class="table"><table><thead><tr>${b.head.map((c) => `<th scope="col">${inlines(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${inlines(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`;
        case 'hr':
          return '<hr>';
      }
    })
    .join('\n');
}

/** The first paragraph after the title and dates: the page's meta description. */
function description(blocks: Block[]): string {
  const p = blocks.find((b): b is Extract<Block, { t: 'p' }> => b.t === 'p' && !/^(Effective date|Last updated)/.test(plainText(b.c)));
  return (p ? plainText(p.c) : '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** One complete HTML document for a legal page: readable without JavaScript, light and dark by system scheme. */
export function legalPageHtml(id: LegalDocId): string {
  const blocks = legalBlocks(id);
  const h1 = blocks.find((b): b is Extract<Block, { t: 'heading' }> => b.t === 'heading' && b.level === 1);
  const title = msg['legal.documentTitle']!.replace('{title}', h1?.text ?? '').replace('{app}', APP);
  const toc = blocks.filter((b): b is Extract<Block, { t: 'heading' }> => b.t === 'heading' && b.level === 2);
  const doc = LEGAL_DOCS.find((d) => d.id === id)!;
  const url = `${SITE_ORIGIN}${doc.path}`;
  const desc = escapeHtml(description(blocks));
  const nav = LEGAL_DOCS.map((d) => `<a href="${d.path}"${d.id === id ? ' aria-current="page"' : ''}>${escapeHtml(msg[`legal.nav.${d.id}`]!)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${APP}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${tokenCss()}${STYLE}</style>
</head>
<body>
<header class="top">
<a class="brand" href="/"><svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="40" fill="var(--c-brand)"/><circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)"/></svg>${APP}</a>
<nav class="nav" aria-label="${escapeHtml(msg['legal.nav.label']!)}">${nav}</nav>
</header>
<div class="layout">
<nav class="toc" aria-label="${escapeHtml(msg['legal.toc']!)}"><p>${escapeHtml(msg['legal.toc']!)}</p><ol>${toc.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('')}</ol></nav>
<main><article lang="en">
${governsNotes()}
${blocksHtml(blocks)}
</article></main>
</div>
<footer class="foot"><a href="/">${APP}</a>${nav}<a href="mailto:support@rolling.actor">support@rolling.actor</a></footer>
</body>
</html>
`;
}

/** `dist/<file>` → contents, for every legal page. */
export function staticLegalFiles(): Record<string, string> {
  return Object.fromEntries(LEGAL_DOCS.map((d) => [`${d.id}.html`, legalPageHtml(d.id)]));
}
