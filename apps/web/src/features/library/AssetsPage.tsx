import { Dialog, useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ChipGroup, motion, PathIcon, paths, SearchField } from '@/features/account/shared';
import { uploadFiles, useTransfers, validateUpload } from '@/lib/transfers';
import { assetFromFile, useAssetMutations, useAssets, useCharacters, useFolders, useStorage, useUpload, useVoiceMutations, useVoices } from './assetsApi';
import type { AssetItem, AssetType, FolderItem, VoiceState } from './assetsMocks';
import styles from './Assets.module.css';
import { isMockApi } from '@/features/overlays/backend';

/**
 * Thumbnail of a listed asset; mature-rated ones are blurred until clicked (D-005).
 * TODO(media): switch to `RatedThumb` from lib/media once it lands.
 */
function RatedImg({ src, mature }: { src: string; mature: boolean }) {
  const [shown, setShown] = useState(!mature);
  return (
    <img
      src={src}
      alt=""
      className={cx(styles.fileImg, !shown && styles.fileImgBlurred)}
      onClick={(e) => {
        if (shown) return;
        e.stopPropagation();
        setShown(true);
      }}
      draggable={false}
    />
  );
}

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
const TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)', 'var(--c-tone-moss)', 'var(--c-tone-clay)', 'var(--c-tone-slate)'];

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
  ready: { bg: 'var(--c-success-soft)', fg: 'var(--c-success)' },
  cloning: { bg: 'var(--c-accent-soft)', fg: 'var(--c-link)' },
  tooShort: { bg: 'var(--c-upgrade-soft)', fg: 'var(--c-upgrade)' },
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
  const [sel, setSel] = useState<string | null>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const assetsMut = useAssetMutations();
  const voicesMut = useVoiceMutations();
  const [uploads, setUploads] = useState<Array<{ id: string; file: File; progress: number }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearInterval(t)), []);

  /** Mock of `POST /api/uploads` + media processing: real progress, then the asset appears. */
  function upload(file: File) {
    if (isVoices) {
      const id = `v_new${Date.now()}`;
      voicesMut.add({ id, name: file.name.replace(/\.[^.]+$/, ''), meta: intl.formatMessage({ id: 'library.assets.voice.clonedMeta' }), state: 'cloning', progress: 0 });
      let pct = 0;
      const t = window.setInterval(() => {
        pct = Math.min(1, pct + 0.25);
        voicesMut.update(id, pct >= 1 ? { state: 'ready', progress: undefined } : { progress: pct });
        if (pct >= 1) {
          window.clearInterval(t);
          toast.show({ message: intl.formatMessage({ id: 'library.assets.voice.done' }, { name: file.name }) });
        }
      }, 400);
      timers.current.push(t);
      return;
    }
    if (validateUpload(file).ok) {
      // Media goes through the shared transfer queue (D-011): direct to R2, resumable.
      const h = uploadFiles([file], { purpose: 'library', quiet: true }).items[0]!;
      setUploads((u) => [...u, { id: h.id, file, progress: 0 }]);
      h.done.then(
        (res) => {
          setUploads((u) => u.filter((x) => x.id !== h.id));
          if (!isMockApi()) {
            void assetsMut.refresh();
            setSel(res.assetId);
            toast.show({ message: intl.formatMessage({ id: 'library.assets.uploaded' }, { name: file.name }) });
            return;
          }
          const a = assetFromFile(file, folder);
          assetsMut.add(a);
          setSel(a.id);
          toast.show({ message: intl.formatMessage({ id: 'library.assets.uploaded' }, { name: file.name }) });
        },
        () => setUploads((u) => u.filter((x) => x.id !== h.id)),
      );
      return;
    }
    // Text notes stay local until text assets have an endpoint.
    const id = `up_${Date.now()}`;
    setUploads((u) => [...u, { id, file, progress: 0 }]);
    let pct = 0;
    const t = window.setInterval(() => {
      pct = Math.min(1, pct + 0.2);
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: pct } : x)));
      if (pct >= 1) {
        window.clearInterval(t);
        setUploads((u) => u.filter((x) => x.id !== id));
        const a = assetFromFile(file, folder);
        assetsMut.add(a);
        setSel(a.id);
        toast.show({ message: intl.formatMessage({ id: 'library.assets.uploaded' }, { name: file.name }) });
      }
    }, 300);
    timers.current.push(t);
  }

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
          <input
            ref={fileRef}
            type="file"
            hidden
            accept={isVoices ? 'audio/*' : 'image/*,video/*,audio/*,text/plain'}
            data-testid="assets-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = '';
            }}
          />
          <button type="button" className={cx(styles.cta, motion.press)} onClick={() => (isChars ? void navigate({ to: '/create/character' }) : fileRef.current?.click())}>
            <PathIcon d={isChars ? paths.plus : paths.upload} size={15} strokeWidth={2.2} />
            <FormattedMessage id={isChars ? 'library.assets.cta.character' : isVoices ? 'library.assets.cta.voice' : 'library.assets.cta.upload'} />
          </button>
        </div>
        {isChars ? <Characters key="chars" query={query} /> : isVoices ? <Voices key="voices" query={query} /> : <Files key={folder} folder={kind === 'favorites' ? 'favorites' : kind === 'project' ? folder : 'all'} query={query} sel={sel} setSel={setSel} uploads={uploads} />}
      </section>

      {!isChars && !isVoices && <FileDetailSlot sel={sel} onDeleted={() => setSel(null)} />}
    </div>
  );
}

function Files({
  folder,
  query,
  sel,
  setSel,
  uploads,
}: {
  folder: string;
  query: string;
  sel: string | null;
  setSel: (id: string) => void;
  uploads: Array<{ id: string; file: File; progress: number }>;
}) {
  const intl = useIntl();
  const { data: assets = [] } = useAssets();
  const { data: upload } = useUpload();
  const queue = useTransfers();
  const progressOf = (u: { id: string; progress: number }) => {
    const t = queue.items.find((i) => i.id === u.id);
    return t ? (t.size ? t.bytesDone / t.size : 0) : u.progress;
  };
  const [type, setType] = useState<TypeFilter>('all');
  const inFolder = (a: (typeof assets)[number]) => (folder === 'all' ? true : folder === 'favorites' ? !!a.favorite : a.folder === folder);
  const visible = assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => inFolder(a) && (type === 'all' || a.type === type) && a.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selId = sel ?? assets[0]?.id ?? null;
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
      {uploads.map((u) => (
        <div key={u.id} className={styles.upload} role="status" data-upload={u.file.name}>
          <PathIcon d={paths.upload} size={16} />
          <span className={styles.uploadName}>
            <FormattedMessage id="library.assets.uploading" values={{ name: u.file.name }} />
          </span>
          <span className={styles.uploadMeta}>
            <FormattedMessage id="library.assets.processing" values={{ mb: Math.max(0.1, Math.round(u.file.size / 1e5) / 10) }} />
          </span>
          <div
            className={styles.uploadTrack}
            role="progressbar"
            aria-label={intl.formatMessage({ id: 'library.assets.uploading' }, { name: u.file.name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressOf(u) * 100)}
          >
            <div className={cx(styles.fill, motion.progress)} style={{ width: `${progressOf(u) * 100}%` }} />
          </div>
        </div>
      ))}
      <div key={type} className={styles.files}>
        {visible.map(({ a, i }, n) => (
          <FileCard key={a.id} asset={a} index={i} order={n} on={selId === a.id} onPick={() => setSel(a.id)} />
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
        {asset.thumbUrl && !audio ? <RatedImg src={asset.thumbUrl} mature={!!asset.mature} /> : null}
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

function FileDetailSlot({ sel, onDeleted }: { sel: string | null; onDeleted: () => void }) {
  const intl = useIntl();
  const toast = useToast();
  const { data: assets = [] } = useAssets();
  const mut = useAssetMutations();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState('');
  const nameId = useId();
  const idx = Math.max(0, sel ? assets.findIndex((x) => x.id === sel) : 0);
  const a = assets[idx];
  if (!a) return null;
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const ext = a.name.split('.').pop()?.toUpperCase() ?? '';
  return (
    <aside aria-label={intl.formatMessage({ id: 'library.assets.details' })} className={styles.detail}>
      <div key={a.id} className={cx(styles.detailInner, motion.enter)}>
        <div className={styles.preview} style={{ background: a.type === 'audio' ? 'var(--c-surface-4)' : TONES[idx % TONES.length] }} />
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
            <Link key={u.label} to={u.to as never} className={cx(styles.usedLink, motion.hover)}>
              <FormattedMessage id="library.assets.usedIn.item" values={{ label: u.label }} />
            </Link>
          ))}
        </div>
        <div className={styles.detailActions}>
          <Link to="/p/$projectId" params={{ projectId: 'prj_demo' }} className={cx(styles.addCanvas, motion.press)}>
            <FormattedMessage id="library.assets.addToCanvas" />
          </Link>
          <button
            type="button"
            className={cx(styles.iconBtn, motion.hover)}
            aria-label={t('library.assets.download')}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([`${a.name}\n${a.meta}\n`], { type: 'text/plain' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = `${a.name}.txt`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              toast.show({ message: t('library.assets.downloaded', { name: a.name }) });
            }}
          >
            <PathIcon d={paths.download} size={15} />
          </button>
          <button
            type="button"
            className={cx(styles.iconBtn, motion.hover)}
            aria-label={t('library.assets.favorite')}
            aria-pressed={!!a.favorite}
            onClick={() => {
              mut.toggleFavorite(a.id);
              toast.show({ message: t(a.favorite ? 'library.assets.unfavorited' : 'library.assets.favorited', { name: a.name }) });
            }}
          >
            <PathIcon d={paths.star} size={15} />
          </button>
          <button
            type="button"
            className={cx(styles.iconBtn, motion.hover)}
            aria-label={t('library.assets.rename')}
            onClick={() => {
              setName(a.name);
              setRenaming(true);
            }}
          >
            <PathIcon d={paths.pencil} size={15} />
          </button>
          <button type="button" className={cx(styles.iconBtn, motion.hover)} aria-label={t('library.assets.delete')} onClick={() => setDeleting(true)}>
            <PathIcon d={paths.trash} size={15} />
          </button>
        </div>
        <Dialog open={renaming} onOpenChange={setRenaming} title={t('library.assets.rename.title')} closeLabel={t('library.assets.close')}>
          <form
            className={styles.dlgForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              mut.rename.mutate({ id: a.id, name: name.trim() });
              setRenaming(false);
              toast.show({ message: t('library.assets.renamed', { name: name.trim() }) });
            }}
          >
            <label htmlFor={nameId} className={styles.dlgLabel}>
              <FormattedMessage id="library.assets.rename.label" />
            </label>
            <input id={nameId} className={styles.dlgInput} value={name} onChange={(e) => setName(e.target.value)} />
            <div className={styles.dlgActions}>
              <button type="button" className={cx(styles.dlgBtn, motion.hover)} onClick={() => setRenaming(false)}>
                <FormattedMessage id="library.assets.cancel" />
              </button>
              <button type="submit" className={cx(styles.dlgBtn, styles.dlgPrimary, motion.press)} disabled={!name.trim()}>
                <FormattedMessage id="library.assets.save" />
              </button>
            </div>
          </form>
        </Dialog>
        <Dialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('library.assets.delete.title', { name: a.name })}
          description={t(a.refs ? 'library.assets.delete.used' : 'library.assets.delete.lead', { n: a.refs })}
          closeLabel={t('library.assets.close')}
        >
          <div className={styles.dlgActions}>
            <button type="button" className={cx(styles.dlgBtn, motion.hover)} onClick={() => setDeleting(false)}>
              <FormattedMessage id="library.assets.cancel" />
            </button>
            <button
              type="button"
              className={cx(styles.dlgBtn, styles.dlgDanger, motion.press)}
              onClick={() => {
                mut.remove.mutate(a.id);
                setDeleting(false);
                onDeleted();
                toast.show({ message: t('library.assets.deleted', { name: a.name }) });
              }}
            >
              <FormattedMessage id="library.assets.delete" />
            </button>
          </div>
        </Dialog>
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
  const [playing, setPlaying] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const { data: voices = [] } = useVoices();
  const visible = voices.filter((v) => v.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={styles.voices}>
      {visible.map((v, i) => {
        const st = VOICE_STYLE[v.state];
        return (
          <div key={v.id} className={cx(styles.voice, motion.stagger)} style={{ '--i': i } as CSSProperties} data-voice={v.id}>
            <button
              type="button"
              className={styles.play}
              aria-label={intl.formatMessage({ id: 'library.assets.voice.preview' }, { name: v.name })}
              aria-pressed={playing === v.id}
              disabled={v.state === 'cloning'}
              onClick={() => {
                window.clearTimeout(timer.current);
                if (playing === v.id) return setPlaying(null);
                setPlaying(v.id);
                timer.current = window.setTimeout(() => setPlaying(null), 2500);
              }}
            >
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
