import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useMemo, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/i18n/locale';
import { LEGAL_DOCS, legalBlocks, type LegalDocId } from './docs';
import type { Block, Inline } from './markdown';
import styles from './Legal.module.css';

/** Internal links go through the router; anchors and external links stay plain. */
function A({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    const [to, hash] = href.split('#');
    return (
      <Link to={to || '.'} hash={hash} className={styles.link}>
        {children}
      </Link>
    );
  }
  const external = /^https?:\/\//.test(href);
  return (
    <a href={href} className={styles.link} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return n.v === '\n' ? <br key={i} /> : <Fragment key={i}>{n.v}</Fragment>;
          case 'strong':
            return (
              <strong key={i}>
                <Inlines nodes={n.c} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case 'code':
            return (
              <code key={i} className={styles.code}>
                {n.v}
              </code>
            );
          case 'link':
            return (
              <A key={i} href={n.href}>
                <Inlines nodes={n.c} />
              </A>
            );
          case 'placeholder':
            return (
              <mark key={i} className={styles.placeholder} data-placeholder>
                {n.v}
              </mark>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'heading': {
            const H = `h${b.level}` as const;
            return (
              <H key={i} id={b.id} className={styles[`h${b.level}`]}>
                <Inlines nodes={b.c} />
              </H>
            );
          }
          case 'p':
            return (
              <p key={i} className={styles.p}>
                <Inlines nodes={b.c} />
              </p>
            );
          case 'ul':
          case 'ol': {
            const L = b.t;
            return (
              <L key={i} className={styles.list}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inlines nodes={item} />
                  </li>
                ))}
              </L>
            );
          }
          case 'quote':
            return (
              <div key={i} className={styles.note} role="note">
                <Blocks blocks={b.c} />
              </div>
            );
          case 'table':
            return (
              <div key={i} className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} scope="col">
                          <Inlines nodes={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, j) => (
                          <td key={j}>
                            <Inlines nodes={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} className={styles.hr} />;
        }
      })}
    </>
  );
}

/**
 * `/terms`, `/privacy`, `/acceptable-use`, `/subprocessors`: public pages
 * (no session needed) rendering `legal/*.md` with a table of contents built
 * from the second-level headings.
 */
export function LegalPage({ doc }: { doc: LegalDocId }) {
  const intl = useIntl();
  const blocks = legalBlocks(doc);
  const title = blocks.find((b) => b.t === 'heading' && b.level === 1);
  const body = useMemo(() => blocks.filter((b) => b !== title), [blocks, title]);
  const toc = useMemo(() => blocks.filter((b): b is Extract<Block, { t: 'heading' }> => b.t === 'heading' && b.level === 2), [blocks]);
  const titleText = title && title.t === 'heading' ? title.text : '';
  const showGoverns = intl.locale !== DEFAULT_LOCALE && (SUPPORTED_LOCALES as readonly string[]).includes(intl.locale);

  useEffect(() => {
    const prev = document.title;
    document.title = intl.formatMessage({ id: 'legal.documentTitle' }, { title: titleText, app: intl.formatMessage({ id: 'app.name' }) });
    return () => {
      document.title = prev;
    };
  }, [intl, titleText]);

  // Deep links to a section (`/privacy#your-rights`) after the first render.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [doc]);

  return (
    <div className={styles.page} data-testid="legal-page" data-doc={doc}>
      <header className={styles.top}>
        <Link to="/" className={styles.brand}>
          <svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
            <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
          </svg>
          <FormattedMessage id="app.name" />
        </Link>
        <nav aria-label={intl.formatMessage({ id: 'legal.nav.label' })} className={styles.nav}>
          {LEGAL_DOCS.map((d) => (
            <Link key={d.id} to={d.path} className={styles.navItem} aria-current={d.id === doc ? 'page' : undefined}>
              <FormattedMessage id={`legal.nav.${d.id}`} />
            </Link>
          ))}
        </nav>
      </header>
      <div className={styles.layout}>
        {toc.length > 1 && (
          <nav aria-label={intl.formatMessage({ id: 'legal.toc' })} className={styles.toc}>
            <p className={styles.tocTitle}>
              <FormattedMessage id="legal.toc" />
            </p>
            <ol className={styles.tocList} lang="en">
              {toc.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className={styles.tocItem}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        {/* D-023: the documents stay English; a translated UI says which version governs. */}
        <article className={styles.article} lang="en">
          {showGoverns && (
            <p className={styles.note} role="note" lang={intl.locale} data-testid="legal-governs">
              <FormattedMessage id="legal.englishGoverns" />
            </p>
          )}
          {title && title.t === 'heading' && (
            <h1 id={title.id} className={styles.h1}>
              <Inlines nodes={title.c} />
            </h1>
          )}
          <Blocks blocks={body} />
        </article>
      </div>
    </div>
  );
}
