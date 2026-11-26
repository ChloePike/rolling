import { useEffect, useRef, useState } from 'react';
import { FADE_MS, nextUnused, ROTATE_MS, showcaseMotionAllowed, type ShowcaseItem } from './showcase';
import styles from './Login.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** Which tile changes on each turn: the middle one first, then right, then left. */
const ORDER = [1, 2, 0] as const;
const TILES = 3;
/** Left (lower), middle (larger, captioned), right (higher): Login.dc.html. */
const TILE_CLASSES = [styles.frameA, styles.frameB, styles.frameC];

interface Rotation {
  /** Item index per tile. */
  slots: number[];
  /** Where the search for the next unused item starts. */
  cursor: number;
  turn: number;
  /** The next item, mounted hidden in its tile so it is the only one preloading. */
  incoming: { slot: number; item: number } | null;
  fading: boolean;
}

function start(count: number, rotate: boolean): Rotation {
  const slots = Array.from({ length: TILES }, (_, i) => i % count);
  const cursor = TILES % count;
  const item = rotate ? nextUnused(count, slots, cursor) : null;
  return { slots, cursor, turn: 0, incoming: item === null ? null : { slot: ORDER[0], item }, fading: false };
}

function commit(r: Rotation, count: number): Rotation {
  if (!r.incoming) return r;
  const slots = r.slots.slice();
  slots[r.incoming.slot] = r.incoming.item;
  const cursor = (r.incoming.item + 1) % count;
  const turn = r.turn + 1;
  const item = nextUnused(count, slots, cursor);
  return { slots, cursor, turn, incoming: item === null ? null : { slot: ORDER[turn % TILES]!, item }, fading: false };
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** A muted looping preview, poster first; plays only while `play` is true. */
function Clip({ item, play, className, state }: { item: ShowcaseItem; play: boolean; className?: string; state?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    if (play) v.play().catch(() => undefined);
    else v.pause();
  }, [play]);
  return (
    <video
      ref={ref}
      className={className}
      src={item.previewUrl}
      poster={item.posterUrl}
      muted
      loop
      playsInline
      disablePictureInPicture
      preload="auto"
      tabIndex={-1}
      data-state={state}
      data-item={item.id}
      data-playing={playing || undefined}
      onPlaying={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      data-testid="showcase-video"
    />
  );
}

function Poster({ item }: { item: ShowcaseItem }) {
  return (
    <picture>
      {item.poster.avif ? <source srcSet={item.poster.avif} type="image/avif" /> : null}
      {item.poster.webp ? <source srcSet={item.poster.webp} type="image/webp" /> : null}
      <img className={styles.layer} src={item.poster.jpg} width={item.width} height={item.height} alt="" decoding="async" data-item={item.id} data-testid="showcase-poster" />
    </picture>
  );
}

/**
 * The sign-in panel's three tiles with real template previews (Login.dc.html sizes
 * and offsets). One tile crossfades to the next unused clip every `ROTATE_MS`,
 * round-robin; only that next clip preloads. Everything pauses while the tab is
 * hidden. Reduced motion or data saver: posters only, nothing rotates or plays.
 */
export default function ShowcaseTiles({ items }: { items: ShowcaseItem[] }) {
  const count = items.length;
  const [motion] = useState(() => showcaseMotionAllowed());
  const rotate = motion && count > TILES;
  const [rot, setRot] = useState<Rotation>(() => start(count, rotate));
  const visible = usePageVisible();

  useEffect(() => {
    if (!rotate || !visible || !rot.incoming) return;
    const t = window.setTimeout(() => setRot((r) => (r.fading ? commit(r, count) : { ...r, fading: true })), rot.fading ? FADE_MS : ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [rotate, visible, rot.fading, rot.turn, rot.incoming, count]);

  const middle = rot.fading && rot.incoming?.slot === 1 ? rot.incoming.item : rot.slots[1]!;

  return (
    <div className={styles.frames} data-showcase={motion ? 'clips' : 'posters'}>
      {TILE_CLASSES.map((tile, s) => {
        const item = items[rot.slots[s]!]!;
        const incoming = rot.incoming?.slot === s ? items[rot.incoming.item]! : null;
        return (
          <div key={s} className={cx(styles.frame, tile)} data-testid="showcase-tile" data-item={item.id}>
            {motion ? (
              <>
                <Clip key={item.id} item={item} play={visible} className={styles.layer} />
                {incoming ? (
                  <Clip
                    key={incoming.id}
                    item={incoming}
                    play={visible && rot.fading}
                    className={cx(styles.layer, styles.incoming)}
                    state={rot.fading ? 'in' : 'next'}
                  />
                ) : null}
              </>
            ) : (
              <Poster item={item} />
            )}
            {s === 1 ? (
              <span className={styles.caption}>
                <span className={styles.captionChip} data-testid="showcase-caption">
                  {items[middle]!.name}
                </span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
