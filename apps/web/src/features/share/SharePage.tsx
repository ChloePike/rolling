import { Link } from '@tanstack/react-router';
import { useMemo, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { ShareNode } from '@/lib/api/types';
import { RatedThumb, type ContentRating } from '@/lib/media';
import { useSession } from '@/lib/session';
import { publicNodes, useShare } from './api';
import styles from './Share.module.css';

const NODE_W = 220;
const NODE_H = 186;

/**
 * `/share/$id` (public, read-only): the shared project's canvas snapshot from
 * `GET /api/share/:id`: nodes at their canvas positions with their media,
 * wires between them, and downloads when the owner allowed them. Mature items
 * never render here (server-side drop, plus `publicNodes` and `RatedThumb`
 * with `publicSurface`).
 */
export function SharePage({ id }: { id: string }) {
  const intl = useIntl();
  const share = useShare(id);
  const session = useSession();
  const data = share.data;
  const nodes = useMemo(() => (data ? publicNodes(data) : []), [data]);
  const layout = useMemo(() => {
    if (!nodes.length) return { w: 0, h: 0, at: new Map<string, { x: number; y: number }>() };
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const at = new Map(nodes.map((n) => [n.id, { x: n.position.x - minX, y: n.position.y - minY }]));
    const w = Math.max(...[...at.values()].map((p) => p.x)) + NODE_W;
    const h = Math.max(...[...at.values()].map((p) => p.y)) + NODE_H;
    return { w, h, at };
  }, [nodes]);
  const edges = (data?.edges ?? []).filter((e) => layout.at.has(e.from.node) && layout.at.has(e.to.node));

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link to="/" className={styles.brand} aria-label={intl.formatMessage({ id: 'header.home' })}>
          <svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="40" fill="var(--c-brand)" />
            <circle cx="64.7" cy="35.3" r="11.6" fill="var(--c-bg)" />
          </svg>
        </Link>
        <h1 className={styles.title}>{data?.title ?? ''}</h1>
        {data && (
          <span className={styles.meta}>
            <FormattedMessage id="share.meta" values={{ n: nodes.length, date: intl.formatDate(data.createdAt, { month: 'short', day: 'numeric' }) }} />
          </span>
        )}
        <Link to={session.status === 'signedIn' ? '/' : '/signup'} className={styles.cta}>
          <FormattedMessage id={session.status === 'signedIn' ? 'share.open' : 'share.signup'} />
        </Link>
      </header>
      {share.isPending ? null : share.isError ? (
        <div className={styles.state} role="alert">
          <p className={styles.stateTitle}>
            <FormattedMessage id="share.error.title" />
          </p>
          <p className={styles.stateSub}>
            <FormattedMessage id="share.error.sub" />
          </p>
        </div>
      ) : !data ? (
        <div className={styles.state} data-testid="share-missing">
          <p className={styles.stateTitle}>
            <FormattedMessage id="share.missing.title" />
          </p>
          <p className={styles.stateSub}>
            <FormattedMessage id="share.missing.sub" />
          </p>
        </div>
      ) : nodes.length === 0 ? (
        <div className={styles.state}>
          <p className={styles.stateSub}>
            <FormattedMessage id="share.empty" />
          </p>
        </div>
      ) : (
        <main className={styles.board} aria-label={intl.formatMessage({ id: 'share.board' })} data-testid="share-board">
          <div className={styles.stage} style={{ width: layout.w, height: layout.h }}>
            <svg className={styles.wires} width={layout.w} height={layout.h} aria-hidden="true">
              {edges.map((e) => {
                const a = layout.at.get(e.from.node)!;
                const b = layout.at.get(e.to.node)!;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x;
                const y2 = b.y + NODE_H / 2;
                const dx = Math.max(40, (x2 - x1) / 2);
                return <path key={e.id} className={styles.wire} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} />;
              })}
            </svg>
            {nodes.map((n) => (
              <NodeCard key={n.id} node={n} pos={layout.at.get(n.id)!} />
            ))}
          </div>
        </main>
      )}
    </div>
  );
}

function NodeCard({ node, pos }: { node: ShareNode; pos: { x: number; y: number } }) {
  const intl = useIntl();
  const m = node.media;
  const style: CSSProperties = { left: pos.x, top: pos.y };
  return (
    <article className={styles.node} style={style} data-node={node.id} aria-label={node.title}>
      {m && (m.thumbUrl || m.url) ? (
        <RatedThumb
          className={styles.thumb}
          src={m.kind === 'video' ? m.url : (m.thumbUrl ?? m.url)}
          poster={m.kind === 'video' ? m.thumbUrl : null}
          kind={m.kind === 'video' ? 'video' : 'image'}
          alt={node.title}
          rating={(node.params?.rating as ContentRating | undefined) ?? null}
          publicSurface
        />
      ) : (
        <span className={styles.empty}>
          <FormattedMessage id={`share.kind.${['script', 'image', 'video', 'audio', 'asset', 'text'].includes(node.kind) ? node.kind : 'other'}`} />
        </span>
      )}
      <div className={styles.nodeHead}>
        <span className={styles.nodeTitle}>{node.title}</span>
        {m?.downloadUrl ? (
          <a className={styles.dl} href={m.downloadUrl} download aria-label={intl.formatMessage({ id: 'share.download.label' }, { name: node.title })}>
            <FormattedMessage id="share.download" />
          </a>
        ) : (
          <span className={styles.kind}>
            <FormattedMessage id={`share.kind.${['script', 'image', 'video', 'audio', 'asset', 'text'].includes(node.kind) ? node.kind : 'other'}`} />
          </span>
        )}
      </div>
    </article>
  );
}
