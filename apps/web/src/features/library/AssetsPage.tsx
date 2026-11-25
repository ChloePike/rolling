import { Link } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ChipGroup, motion, PathIcon, paths, SearchField } from '../account/shared';
import { useAssets, useCharacters, useFolders, useStorage, useUpload, useVoices } from './assetsApi';
import type { AssetItem, AssetType, FolderItem, VoiceState } from './assetsMocks';
import styles from './Assets.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
const TONES = ['#26232A', '#1F2628', '#202330', '#28251F', '#26262A', '#1F2622', '#2A2420', '#22262E'];

export const ASSET_FOLDERS = ['all', 'characters', 'voices', 'favorites', 'prj_ridgeline', 'prj_desk'] as const;
export type AssetFolder = string;

const FOLDER_ICONS: Record<FolderItem['kind'], string> = {
  all: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  characters: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  voices: 'M2 10v3 M6 6v11 M10 3v18 M14 8v7 M18 5v13 M22 10v3',
  favorites:
    'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
  project: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
};

const VOICE_STYLE: Record<VoiceState, { bg: string; fg: string }> = {
  ready: { bg: 'rgba(34,197,94,.14)', fg: '#4ADE80' },
  cloning: { bg: 'rgba(59,130,246,.16)', fg: '#93C5FD' },
  tooShort: { bg: 'rgba(255,197,61,.14)', fg: '#FFC53D' },
};

const TYPES = ['all', 'image', 'video', 'audio', 'text'] as const;
type TypeFilter = (typeof TYPES)[number];

function folderLabel(f: FolderItem, intl: ReturnType<typeof useIntl>) {
  return f.kind === 'project' ? (f.title ?? '') : intl.formatMessage({ id: `library.assets.folder.${f.kind}` });
}

/** `MM-DD HH:mm` built from Intl parts (the design’s compact upload time). */
function compactDate(iso: string, locale: string) {
  const parts = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** `/assets` (Assets.dc.html): files, Characters and Voices folders. */
export function AssetsPage({ folder = 'all' }: { folder?: AssetFolder }) {
  const intl = useIntl();
  const { data: folders = [] } = useFolders();
  const { data: storage } = useStorage();
  const current = folders.find((f) => f.id === folder) ?? folders[0];
  const kind = current?.kind ?? 'all';
  const isChars = kind === 'characters';
  const isVoices = kind === 'voices';
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  return (
    <div className={styles.page}>
      <nav aria-label={intl.formatMessage({ id: 'library.assets.folders' })} className={styles.folders}>
        {folders.map((f) => (
          <Link
            key={f.id}
            to="/assets"
            search={f.id === 'all' ? {} : { folder: f.id }}
            className={styles.folder}
            aria-current={f.id === current?.id ? 'page' : undefined}
          >
            <PathIcon d={FOLDER_ICONS[f.kind]} size={16} />
            <span className={styles.folderLabel}>{folderLabel(f, intl)}</span>
            <span className={styles.folderCount}>{intl.formatNumber(f.count)}</span>
          </Link>
        ))}
        {storage && (
          <div className={styles.storage}>
            <span className={styles.storageKey}>
              <FormattedMessage id="library.assets.storage" />
            </span>
            <div
              className={styles.track}
              role="progressbar"
              aria-label={intl.formatMessage({ id: 'library.assets.storage' })}
              aria-valuemin={0}
              aria-valuemax={storage.totalGb}
              aria-valuenow={storage.usedGb}
            >
              <div className={cx(styles.fill, motion.progress)} style={{ width: `${(storage.usedGb / storage.totalGb) * 100}%` }} />
            </div>
            <span className={styles.storageVal}>
              <FormattedMessage id="library.assets.storage.value" values={{ used: storage.usedGb, total: storage.totalGb }} />
            </span>
          </div>
        )}
      </nav>

      <section className={styles.main} aria-labelledby="assets-title">
        <div className={styles.head}>
          <h1 id="assets-title" className={styles.title}>
            {current ? folderLabel(current, intl) : <FormattedMessage id="library.assets.folder.all" />}
          </h1>
          <span className={styles.spacer} />
          <SearchField placeholder={intl.formatMessage({ id: 'library.assets.search' })} value={query} onChange={setQuery} />
          <button type="button" className={cx(styles.cta, motion.press)}>
            <PathIcon d={isChars ? paths.plus : paths.upload} size={15} strokeWidth={2.2} />
            <FormattedMessage id={isChars ? 'library.assets.cta.character' : isVoices ? 'library.assets.cta.voice' : 'library.assets.cta.upload'} />
          </button>
        </div>
        {isChars ? <Characters key="chars" query={query} /> : isVoices ? <Voices key="voices" query={query} /> : <Files key={folder} query={query} sel={sel} setSel={setSel} />}
      </section>

      {!isChars && !isVoices && <FileDetailSlot sel={sel} />}
    </div>
  );
}

function Files({ query, sel, setSel }: { query: string; sel: number; setSel: (i: number) => void }) {
  const intl = useIntl();
  const { data: assets = [] } = useAssets();
  const { data: upload } = useUpload();
  const [type, setType] = useState<TypeFilter>('all');
  const visible = assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => (type === 'all' || a.type === type) && a.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <ChipGroup
        label={intl.formatMessage({ id: 'library.assets.types' })}
        value={type}
        onChange={setType}
        options={TYPES.map((t) => ({ value: t, label: intl.formatMessage({ id: `library.assets.type.${t}` }) }))}
      />
      {upload && (
        <div className={styles.upload} role="status">
          <PathIcon d={paths.upload} size={16} />
          <span className={styles.uploadName}>
            <FormattedMessage id="library.assets.uploading" values={{ name: upload.name }} />
          </span>
          <span className={styles.uploadMeta}>
            <FormattedMessage id="library.assets.processing" values={{ mb: upload.sizeMb }} />
          </span>
          <div
            className={styles.uploadTrack}
            role="progressbar"
            aria-label={intl.formatMessage({ id: 'library.assets.uploading' }, { name: upload.name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(upload.progress * 100)}
          >
            <div className={cx(styles.fill, motion.progress)} style={{ width: `${upload.progress * 100}%` }} />
          </div>
        </div>
      )}
      <div key={type} className={styles.files}>
        {visible.map(({ a, i }, n) => (
          <FileCard key={a.id} asset={a} index={i} order={n} on={sel === i} onPick={() => setSel(i)} />
        ))}
        {visible.length === 0 && (
          <p className={styles.empty}>
            <FormattedMessage id="library.assets.empty" />
          </p>
        )}
      </div>
    </>
  );
}

function FileCard({ asset, index, order, on, onPick }: { asset: AssetItem; index: number; order: number; on: boolean; onPick: () => void }) {
  const intl = useIntl();
  const audio = asset.type === 'audio';
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cx(styles.file, motion.stagger)}
      style={{ '--i': order } as CSSProperties}
      onClick={onPick}
      data-asset={asset.id}
    >
      <span className={styles.fileThumb} style={{ aspectRatio: asset.ar, background: audio ? 'var(--c-surface-4)' : TONES[index % TONES.length] }}>
        <span className={styles.typeBadge}>{intl.formatMessage({ id: `library.assets.type.${asset.type}` })}</span>
        {audio && (
          <span className={styles.wave} aria-hidden="true">
            {[10, 20, 14, 22, 8].map((h, k) => (
              <span key={k} style={{ height: h }} />
            ))}
          </span>
        )}
      </span>
      <span className={styles.fileName}>{asset.name}</span>
      <span className={styles.fileMeta}>
        <span>{asset.meta}</span>
        <span>{asset.refs ? intl.formatMessage({ id: 'library.assets.refs' }, { n: asset.refs }) : ''}</span>
      </span>
    </button>
  );
}

function FileDetailSlot({ sel }: { sel: number }) {
  const intl = useIntl();
  const { data: assets = [] } = useAssets();
  const a = assets[sel];
  if (!a) return null;
  const ext = a.name.split('.').pop()?.toUpperCase() ?? '';
  return (
    <aside aria-label={intl.formatMessage({ id: 'library.assets.details' })} className={styles.detail}>
      <div key={a.id} className={cx(styles.detailInner, motion.enter)}>
        <div className={styles.preview} style={{ background: a.type === 'audio' ? 'var(--c-surface-4)' : TONES[sel % TONES.length] }} />
        <div className={styles.detailHead}>
          <span className={styles.detailName}>{a.name}</span>
          <span className={styles.detailMeta}>
            <FormattedMessage id="library.assets.detailMeta" values={{ type: intl.formatMessage({ id: `library.assets.type.${a.type}` }), meta: a.meta }} />
          </span>
        </div>
        <div className={styles.facts}>
          {[
            ['source', intl.formatMessage({ id: `library.assets.source.${a.source}` })],
            ['version', intl.formatMessage({ id: 'library.assets.versionN' }, { n: a.version })],
            ['uploaded', compactDate(a.uploadedAt, intl.locale)],
            ['format', ext],
          ].map(([k, v]) => (
            <div key={k} className={styles.fact}>
              <span className={styles.factKey}>
                <FormattedMessage id={`library.assets.fact.${k}`} />
              </span>
              <span className={styles.factValue}>{v}</span>
            </div>
          ))}
        </div>
        <div className={styles.used}>
          <span className={styles.usedKey}>
            <FormattedMessage id="library.assets.usedIn" values={{ n: a.usedIn.length }} />
          </span>
          {a.usedIn.map((u) => (
            <a key={u.label} href={u.to} className={cx(styles.usedLink, motion.hover)}>
              <FormattedMessage id="library.assets.usedIn.item" values={{ label: u.label }} />
            </a>
          ))}
        </div>
        <div className={styles.detailActions}>
          <Link to="/p/$projectId" params={{ projectId: 'prj_demo' }} className={cx(styles.addCanvas, motion.press)}>
            <FormattedMessage id="library.assets.addToCanvas" />
          </Link>
          <button type="button" className={cx(styles.iconBtn, motion.hover)} aria-label={intl.formatMessage({ id: 'library.assets.download' })}>
            <PathIcon d={paths.download} size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Characters({ query }: { query: string }) {
  const intl = useIntl();
  const { data: chars = [] } = useCharacters();
  const visible = chars.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={styles.chars}>
      {visible.map((c, i) => (
        <div key={c.id} className={cx(styles.char, motion.stagger)} style={{ '--i': i } as CSSProperties} data-character={c.id}>
          <div className={styles.charViews} aria-hidden="true">
            <span style={{ background: TONES[i % TONES.length] }} />
            <span style={{ background: TONES[(i + 3) % TONES.length] }} />
          </div>
          <div className={styles.charHead}>
            <span className={styles.charText}>
              <span className={styles.charName}>@{c.name}</span>
              <span className={styles.charMeta}>
                <FormattedMessage id="library.assets.character.meta" values={{ meta: c.meta, n: c.projects }} />
              </span>
            </span>
            <span className={styles.charId}>{c.id}</span>
          </div>
          <div className={styles.charActions}>
            <Link to="/p/$projectId" params={{ projectId: 'prj_demo' }} className={cx(styles.charPrimary, motion.press)}>
              <FormattedMessage id="library.assets.character.create" />
            </Link>
            <Link to="/create/character" className={cx(styles.charEdit, motion.hover)} aria-label={intl.formatMessage({ id: 'library.assets.character.edit.label' }, { name: c.name })}>
              <FormattedMessage id="library.assets.character.edit" />
            </Link>
          </div>
        </div>
      ))}
      <Link to="/create/character" className={cx(styles.newChar, motion.stagger)} style={{ '--i': visible.length } as CSSProperties}>
        <span className={styles.newCharIcon}>
          <PathIcon d={paths.plus} size={20} />
        </span>
        <span className={styles.newCharLabel}>
          <FormattedMessage id="library.assets.cta.character" />
        </span>
      </Link>
    </div>
  );
}

function Voices({ query }: { query: string }) {
  const intl = useIntl();
  const { data: voices = [] } = useVoices();
  const visible = voices.filter((v) => v.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={styles.voices}>
      {visible.map((v, i) => {
        const st = VOICE_STYLE[v.state];
        return (
          <div key={v.id} className={cx(styles.voice, motion.stagger)} style={{ '--i': i } as CSSProperties} data-voice={v.id}>
            <button type="button" className={styles.play} aria-label={intl.formatMessage({ id: 'library.assets.voice.preview' }, { name: v.name })}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
              </svg>
            </button>
            <span className={styles.voiceText}>
              <span className={styles.voiceName}>{v.name}</span>
              <span className={styles.voiceMeta}>{v.meta}</span>
            </span>
            <span className={styles.voiceState} style={{ background: st.bg, color: st.fg }}>
              <FormattedMessage id={`library.assets.voice.${v.state}`} values={{ pct: v.progress ?? 0 }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
