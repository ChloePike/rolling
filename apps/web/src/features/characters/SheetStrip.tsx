import { useIntl } from 'react-intl';
import { useCharacter } from './api';
import styles from './SheetStrip.module.css';

/** Characters saved on the server have `chr_` ids; mock and legacy ids have no sheet to show. */
export function characterIdOf(params: Record<string, unknown>): string | null {
  const id = typeof params.characterId === 'string' ? params.characterId : typeof params.refId === 'string' ? params.refId : null;
  return id && id.startsWith('chr_') ? id : null;
}

/**
 * The canvas character node's sheet (D-032): the saved views of the
 * character's current version, as a strip over the bottom of the asset body
 * (the card keeps its size). The view this node passes is marked.
 */
export function SheetStrip({ characterId, activeView }: { characterId: string; activeView?: string }) {
  const intl = useIntl();
  const q = useCharacter(characterId);
  const views = q.data?.sheet ?? [];
  if (views.length === 0) return null;
  return (
    <div className={styles.strip} role="img" aria-label={intl.formatMessage({ id: 'characters.node.sheet' }, { name: q.data!.name })} data-testid="node-character-sheet">
      {views.slice(0, 6).map((v) => (
        <span key={v.view} className={styles.cell} data-view={v.view} data-active={v.view === activeView || undefined}>
          {v.thumbUrl ?? v.url ? <img src={(v.thumbUrl ?? v.url)!} alt="" draggable={false} className={styles.img} /> : null}
        </span>
      ))}
    </div>
  );
}
