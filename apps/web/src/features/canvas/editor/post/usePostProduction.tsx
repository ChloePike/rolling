/**
 * Post-production in the editor (D-033 .. D-037), reached from the Effects
 * menu so the editor's layout stays the approved one:
 * - Auto captions (Whisper; language detected; Clean / Bold social / Minimal),
 *   caption files (SRT, WebVTT) and the caption look;
 * - Extend clip (the shot's last frame starts a new image-to-video run) and
 *   Lip-sync to voice (a shot speaks a voice clip), both through the shared run
 *   flow (quote, RunConfirm above the threshold, paywall);
 * - Reframe for other aspect ratios (follow the subject, or a fixed point);
 * - Import voiceover (upload or record, with the rights note), split it on its
 *   pauses, duck the music under it.
 */
import { Dialog, Progress, SegmentedControl, Switch, useToast } from '@rolling/ui';
import { useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { CAPTION_LOOKS, captionFontStack, captionTrackOf, cuesOfEdl, resolveCaptionLook, toSrt, toVtt } from '@rolling/core/post';
import { clipEnd, findClip, isCaptionClip, nextClipId, type CaptionStyleId, type Clip, type Edl, type MediaClip, type Reframe, type TimelineOp, type Track } from '@rolling/core/timeline';
import type { MenuEntry } from '../../layers/Menu';
import type { EditorProject } from '../mocks';
import type { RunRequest as FlowRequest } from '@/features/overlays/useRunFlow';
import { assetMediaUrl, isMockApi } from '@/features/overlays/backend';
import { uploadToAssets } from '@/features/picker/data';
import { BrandKitDialog } from './BrandKitDialog';
import { attestVoiceRights, followJob, quoteExtend, quoteLipSync, resizeAsset, runCaptions, splitVoiceover, type CaptionSource } from './api';
import styles from './PostDialogs.module.css';
import eStyles from '../Editor.module.css';

const STYLES: CaptionStyleId[] = ['clean', 'bold_social', 'minimal'];
const LANGUAGES = ['en', 'ja', 'ko', 'zh', 'es', 'pt', 'de', 'fr', 'id', 'th', 'vi'];
const EXTEND_SECONDS = ['4', '5', '8', '10'] as const;

export interface PostProductionInput {
  project: EditorProject;
  edl: Edl;
  selected: { clip: Clip; track: Track } | null;
  playheadTime: number;
  commit: (ops: TimelineOp[], select?: string) => void;
  runFlow: { request: (req: FlowRequest) => void };
  /** Real mode (a server timeline). */
  real: boolean;
}

type Open = null | 'captions' | 'extend' | 'lipsync' | 'voiceover' | 'brand' | 'reframe';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** SRT / WebVTT of the cut's captions, as a file download. */
export function downloadCaptions(edl: Edl, format: 'srt' | 'vtt', baseName: string) {
  const cues = cuesOfEdl(edl);
  const lang = captionTrackOf(edl)?.lang ?? null;
  if (format === 'srt') download(`${baseName}.srt`, toSrt(cues), 'application/x-subrip');
  else download(`${baseName}.vtt`, toVtt(cues, lang), 'text/vtt');
}

/** Inline style of the monitor's caption for the track's look (font stack with CJK fallback, brand-free preview). */
export function captionPreviewStyle(edl: Edl): React.CSSProperties {
  const track = captionTrackOf(edl);
  const look = resolveCaptionLook(track?.style, { lang: track?.lang ?? null });
  const shadow = look.shadow ? `0 1px 3px ${look.outlineColor}` : undefined;
  const outline = look.outline > 0 ? `${look.outlineColor} 0 0 1px, ${look.outlineColor} 0 0 2px, ${look.outlineColor} 0 0 3px` : undefined;
  return {
    fontFamily: captionFontStack(track?.lang ?? null),
    fontWeight: look.weight,
    fontSize: `${(12 * look.size) / 0.05}px`,
    color: look.text,
    bottom: `${look.marginV * 100}%`,
    ...(look.box ? { background: `color-mix(in srgb, ${look.boxColor} ${Math.round(look.box.opacity * 100)}%, transparent)`, padding: '1px 6px', borderRadius: 3, left: 'auto', right: 'auto', justifySelf: 'center' } : {}),
    ...(outline || shadow ? { textShadow: [outline, shadow].filter(Boolean).join(', ') } : {}),
    whiteSpace: 'pre-line',
    wordBreak: 'keep-all',
  };
}

export function usePostProduction(input: PostProductionInput): { entries: MenuEntry[]; element: ReactNode } {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const { edl, selected, commit, project } = input;
  const media = selected && !isCaptionClip(selected.clip) ? (selected.clip as MediaClip) : null;
  const shot = media && selected?.track.kind === 'video' ? media : null;
  const voice = media && selected?.track.kind === 'voice' ? media : null;
  const music = media && selected?.track.kind === 'music' ? media : null;
  const voiceTrack = edl.tracks.find((tr) => tr.kind === 'voice');

  const needShot = t('post.menu.needShot');
  const entries: MenuEntry[] = [
    { key: 'post-captions', label: t('post.menu.captions'), onSelect: () => setOpen('captions') },
    { key: 'post-extend', label: t('post.menu.extend'), disabled: !shot?.assetId, reason: needShot, onSelect: () => setOpen('extend') },
    { key: 'post-lipsync', label: t('post.menu.lipsync'), disabled: !shot || !voiceTrack?.clips.length, reason: !shot ? needShot : t('post.menu.needVoice'), onSelect: () => setOpen('lipsync') },
    ...(['1080p', '4K'] as const).map<MenuEntry>((target) => ({
      key: `post-resize-${target}`,
      label: t('post.resize.label', { target }),
      hint: t('post.resize.note'),
      disabled: !shot?.assetId,
      reason: needShot,
      onSelect: () => {
        if (!shot?.assetId) return;
        const at = shot.nodeId && input.real ? { projectId: project.id, nodeId: shot.nodeId } : undefined;
        toast.show({ message: t('post.resize.started', { target }) });
        void resizeAsset(shot.assetId, target, at)
          .then((job) => followJob(job, () => {}))
          .then(
            (job) => toast.show({ message: job.status === 'done' ? t('post.resize.done', { target }) : (job.error?.message ?? t('post.failed')) }),
            (e: unknown) => toast.show({ message: e instanceof Error ? e.message : t('post.failed') }),
          );
      },
    })),
    { key: 'post-reframe', label: t('post.menu.reframe'), disabled: !shot, reason: needShot, onSelect: () => setOpen('reframe') },
    { key: 'post-brand', label: t('post.menu.brandKit'), onSelect: () => setOpen('brand') },
    { key: 'post-voiceover', label: t('post.menu.voiceover'), disabled: !voiceTrack, reason: t('post.menu.noVoiceLane'), onSelect: () => setOpen('voiceover') },
    {
      key: 'post-split',
      label: t('post.menu.split'),
      disabled: !voice?.assetId || !input.real,
      reason: t('post.menu.needVoiceClip'),
      onSelect: () => {
        if (!voice) return;
        void splitVoiceover(project.id, voice.id, true).then(
          (r) => toast.show({ message: t('post.split.done', { n: r.parts.length }) }),
          (e: unknown) => toast.show({ message: e instanceof Error ? e.message : t('post.failed') }),
        );
      },
    },
    {
      key: 'post-duck',
      label: t('post.menu.duck'),
      kind: 'checkbox',
      checked: !!music && !!voiceTrack && (music.duckUnder ?? []).includes(voiceTrack.id),
      disabled: !music || !voiceTrack,
      reason: t('post.menu.needMusic'),
      onSelect: () => {
        if (!music || !voiceTrack) return;
        const on = (music.duckUnder ?? []).includes(voiceTrack.id);
        commit([{ op: 'setDuck', clipId: music.id, duckUnder: on ? [] : [voiceTrack.id] }]);
      },
    },
  ];

  const element = (
    <>
      <CaptionsDialog open={open === 'captions'} onClose={() => setOpen(null)} input={input} selectedClip={media} />
      {shot ? <ExtendDialog open={open === 'extend'} onClose={() => setOpen(null)} input={input} shot={shot} /> : null}
      {shot ? <LipSyncDialog open={open === 'lipsync'} onClose={() => setOpen(null)} input={input} shot={shot} /> : null}
      {shot ? <ReframeDialog open={open === 'reframe'} onClose={() => setOpen(null)} input={input} shot={shot} /> : null}
      <VoiceoverDialog open={open === 'voiceover'} onClose={() => setOpen(null)} input={input} />
      <BrandKitDialog open={open === 'brand'} onClose={() => setOpen(null)} projectId={project.id} />
    </>
  );
  return { entries, element };
}

function useT() {
  const intl = useIntl();
  return { intl, t: (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v) };
}

function CaptionsDialog({ open, onClose, input, selectedClip }: { open: boolean; onClose: () => void; input: PostProductionInput; selectedClip: MediaClip | null }) {
  const { intl, t } = useT();
  const toast = useToast();
  const [source, setSource] = useState<'timeline' | 'voice' | 'clip'>('timeline');
  const [language, setLanguage] = useState('auto');
  const [style, setStyle] = useState<CaptionStyleId>(captionTrackOf(input.edl)?.style ?? 'clean');
  const [replace, setReplace] = useState(true);
  const [phase, setPhase] = useState<{ kind: 'setup' } | { kind: 'running'; p: number } | { kind: 'failed'; reason: string }>({ kind: 'setup' });
  const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([intl.locale], { type: 'language' }) : null;
  const look = resolveCaptionLook(style, { lang: language === 'auto' ? null : language });
  const track = captionTrackOf(input.edl);
  const hasCaptions = cuesOfEdl(input.edl).length > 0;
  const fileBase = input.project.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'captions';
  const start = () => {
    const src: CaptionSource = source === 'clip' && selectedClip ? { kind: 'clip', clipId: selectedClip.id } : source === 'voice' ? { kind: 'voice' } : { kind: 'timeline' };
    setPhase({ kind: 'running', p: 0.05 });
    runCaptions(input.project.id, input.edl, { source: src, style, language, replace }, (p) => setPhase({ kind: 'running', p }), (ops) => input.commit(ops)).then(
      (job) => {
        if (job.status === 'failed') return setPhase({ kind: 'failed', reason: job.error?.message ?? t('post.failed') });
        const lang = job.result?.language ? (names?.of(job.result.language) ?? job.result.language) : t('post.captions.unknownLanguage');
        toast.show({ message: t('post.captions.done', { n: job.result?.cues ?? 0, language: lang }) });
        setPhase({ kind: 'setup' });
        onClose();
      },
      (e: unknown) => setPhase({ kind: 'failed', reason: e instanceof Error ? e.message : t('post.failed') }),
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.captions.title')} closeLabel={t('post.close')} width={460}>
      <div className={styles.body} data-testid="captions-dialog" data-phase={phase.kind}>
        {phase.kind === 'running' ? (
          <>
            <Progress value={phase.p} label={t('post.captions.progressLabel')} />
            <p className={styles.note} role="status">{t('post.captions.progress', { p: phase.p })}</p>
          </>
        ) : (
          <>
            <div className={styles.row}>
              <span className={styles.label}>{t('post.captions.source')}</span>
              <SegmentedControl
                label={t('post.captions.source')}
                value={source}
                onValueChange={(v) => setSource(v as typeof source)}
                options={[
                  { value: 'timeline', label: t('post.captions.source.timeline') },
                  { value: 'voice', label: t('post.captions.source.voice') },
                  { value: 'clip', label: t('post.captions.source.clip'), disabled: !selectedClip },
                ]}
              />
            </div>
            <label className={styles.row}>
              <span className={styles.label}>{t('post.captions.language')}</span>
              <select className={styles.select} value={language} onChange={(e) => setLanguage(e.target.value)} aria-label={t('post.captions.language')}>
                <option value="auto">{t('post.captions.detect')}</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {names?.of(l) ?? l}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.row}>
              <span className={styles.label}>{t('post.captions.style')}</span>
              <SegmentedControl label={t('post.captions.style')} value={style} onValueChange={(v) => setStyle(v as CaptionStyleId)} options={STYLES.map((s) => ({ value: s, label: t(`post.style.${s}`) }))} />
              <div className={styles.sample} aria-hidden="true">
                <span
                  className={styles.sampleText}
                  style={{
                    fontFamily: captionFontStack(language === 'auto' ? null : language),
                    fontWeight: look.weight,
                    fontSize: `${Math.round(84 * look.size * 3.2)}px`,
                    color: look.text,
                    bottom: `${Math.round(look.marginV * 60)}%`,
                    ...(look.box ? { background: `color-mix(in srgb, ${look.boxColor} ${Math.round(look.box.opacity * 100)}%, transparent)` } : {}),
                    ...(look.outline > 0 || look.shadow ? { textShadow: `0 0 2px ${look.outlineColor}, 0 1px 3px ${look.outlineColor}` } : {}),
                  }}
                >
                  {t('post.captions.sample')}
                </span>
              </div>
              <p className={styles.hint}>{t(`post.style.${style}.hint`, { lines: CAPTION_LOOKS[style].maxLines })}</p>
            </div>
            <label className={styles.check}>
              <Switch checked={replace} onCheckedChange={setReplace} size="sm" aria-label={t('post.captions.replace')} />
              <span>{t('post.captions.replace')}</span>
            </label>
            {phase.kind === 'failed' ? (
              <p className={styles.note} role="alert">
                {t('post.captions.failed', { reason: phase.reason })}
              </p>
            ) : (
              <p className={styles.hint}>{t('post.captions.free')}</p>
            )}
            {track && hasCaptions ? (
              <div className={styles.row}>
                <span className={styles.label}>{t('post.export.captionFiles')}</span>
                <div className={styles.files}>
                  <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={() => downloadCaptions(input.edl, 'srt', fileBase)}>
                    {t('post.menu.srt')}
                  </button>
                  <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={() => downloadCaptions(input.edl, 'vtt', fileBase)}>
                    {t('post.menu.vtt')}
                  </button>
                </div>
              </div>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={onClose}>
                {t('post.cancel')}
              </button>
              {track && hasCaptions ? (
                <button
                  type="button"
                  className={`${eStyles.btn} ${eStyles.secondary}`}
                  onClick={() => {
                    input.commit([{ op: 'setCaptionTrack', trackId: track.id, style }]);
                    onClose();
                  }}
                >
                  {t('post.captions.applyLook')}
                </button>
              ) : null}
              <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} onClick={start}>
                {t('post.captions.start')}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function ExtendDialog({ open, onClose, input, shot }: { open: boolean; onClose: () => void; input: PostProductionInput; shot: MediaClip }) {
  const { t } = useT();
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState<(typeof EXTEND_SECONDS)[number]>('5');
  const go = () => {
    const sec = Number(seconds);
    onClose();
    input.runFlow.request({
      cost: isMockApi() ? 210 : 0,
      kind: 'video',
      actionLabel: t('post.extend.action'),
      meta: t('post.extend.meta', { seconds: sec }),
      ...(input.real ? { projectId: input.project.id, quote: () => quoteExtend(input.project.id, { clipId: shot.id, prompt: prompt.trim(), seconds: sec }) } : {}),
      onDone: (r) => {
        // Real mode: the server places the clip (timeline.patched); its media URL is added here.
        if (input.real) {
          if (r.assetId && input.project.mediaUrls) input.project.mediaUrls[r.assetId] = assetMediaUrl(r.assetId);
          return;
        }
        const ref = findClip(input.edl, shot.id);
        if (!ref) return;
        const at = clipEnd(shot);
        const later = (ref.track.clips as MediaClip[]).filter((c) => c.id !== shot.id && c.start >= at - 1e-6).sort((a, b) => b.start - a.start);
        const id = nextClipId(input.edl, 'ext1');
        input.commit([...later.map<TimelineOp>((c) => ({ op: 'move', clipId: c.id, start: c.start + sec })), { op: 'insert', trackId: ref.track.id, clip: { id, assetId: `ast_ext_${r.id}`, in: 0, out: sec, start: at } }], id);
      },
    });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.extend.title')} closeLabel={t('post.close')} width={440}>
      <div className={styles.body} data-testid="extend-dialog">
        <p className={styles.note}>{t('post.extend.note')}</p>
        <label className={styles.row}>
          <span className={styles.label}>{t('post.extend.prompt')}</span>
          <textarea className={styles.text} value={prompt} maxLength={2000} placeholder={t('post.extend.placeholder')} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className={styles.row}>
          <span className={styles.label}>{t('post.extend.length')}</span>
          <SegmentedControl label={t('post.extend.length')} value={seconds} onValueChange={(v) => setSeconds(v as typeof seconds)} options={EXTEND_SECONDS.map((s) => ({ value: s, label: t('post.seconds', { s: Number(s) }) }))} />
        </div>
        <div className={styles.actions}>
          <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={onClose}>
            {t('post.cancel')}
          </button>
          <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} disabled={!prompt.trim()} onClick={go}>
            {t('post.extend.continue')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function LipSyncDialog({ open, onClose, input, shot }: { open: boolean; onClose: () => void; input: PostProductionInput; shot: MediaClip }) {
  const { t } = useT();
  const toast = useToast();
  const voices = input.edl.tracks.filter((tr) => tr.kind === 'voice').flatMap((tr) => tr.clips as MediaClip[]).filter((c) => c.assetId);
  const overlapping = voices.find((v) => v.start < clipEnd(shot) && clipEnd(v) > shot.start);
  const [voiceId, setVoiceId] = useState(overlapping?.id ?? voices[0]?.id ?? '');
  const [rights, setRights] = useState(false);
  const voice = voices.find((v) => v.id === voiceId);
  const go = async () => {
    if (!voice?.assetId) return;
    try {
      await attestVoiceRights(voice.assetId);
    } catch (e) {
      return void toast.show({ message: e instanceof Error ? e.message : t('post.failed') });
    }
    onClose();
    input.runFlow.request({
      cost: isMockApi() ? 420 : 0,
      kind: 'video',
      actionLabel: t('post.lipsync.action'),
      meta: t('post.lipsync.meta', { seconds: Math.round((voice.out - voice.in) * 10) / 10 }),
      ...(input.real ? { projectId: input.project.id, quote: () => quoteLipSync(input.project.id, { shotClipId: shot.id, voiceClipId: voice.id }) } : {}),
      onDone: (r) => {
        if (input.real) {
          if (r.assetId && input.project.mediaUrls) input.project.mediaUrls[r.assetId] = assetMediaUrl(r.assetId);
          return;
        }
        input.commit([{ op: 'replaceShot', clipId: shot.id, nodeId: shot.nodeId ?? 'node_lipsync', assetId: `ast_ls_${r.id}` }], shot.id);
      },
    });
  };
  const fmt = (s: number) => t('post.seconds', { s: Math.round(s * 10) / 10 });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.lipsync.title')} closeLabel={t('post.close')} width={440}>
      <div className={styles.body} data-testid="lipsync-dialog">
        <p className={styles.note}>{t('post.lipsync.note')}</p>
        <label className={styles.row}>
          <span className={styles.label}>{t('post.lipsync.voice')}</span>
          <select className={styles.select} value={voiceId} onChange={(e) => setVoiceId(e.target.value)} aria-label={t('post.lipsync.voice')}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {t('post.lipsync.voiceOption', { start: fmt(v.start), length: fmt(v.out - v.in) })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
          <span>{t('post.rights')}</span>
        </label>
        <p className={styles.hint}>{t('post.lipsync.matureNote')}</p>
        <div className={styles.actions}>
          <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={onClose}>
            {t('post.cancel')}
          </button>
          <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} disabled={!voice || !rights} onClick={() => void go()}>
            {t('post.lipsync.continue')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Import voiceover: an audio file or a recording (MediaRecorder), with the rights note, onto the voice lane at the playhead. */
function VoiceoverDialog({ open, onClose, input }: { open: boolean; onClose: () => void; input: PostProductionInput }) {
  const { t } = useT();
  const toast = useToast();
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canRecord = typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && !!navigator.mediaDevices?.getUserMedia;

  const place = (assetId: string, seconds: number) => {
    const track = input.edl.tracks.find((tr) => tr.kind === 'voice');
    if (!track) return;
    const clips = track.clips as MediaClip[];
    // At the playhead, or after the voice clip under it.
    let start = input.playheadTime;
    for (const c of [...clips].sort((a, b) => a.start - b.start)) if (c.start < start + seconds && clipEnd(c) > start) start = clipEnd(c);
    const id = nextClipId(input.edl, clips[0]?.id ?? 'a1');
    if (input.project.mediaUrls) input.project.mediaUrls[assetId] = assetMediaUrl(assetId);
    input.project.audio[assetId] = { assetId, title: t('post.voiceover.clipTitle'), seconds, peaks: [0] };
    input.commit([{ op: 'insert', trackId: track.id, clip: { id, assetId, in: 0, out: Math.max(0.1, seconds), start } }], id);
    return id;
  };

  const take = async (file: File) => {
    setBusy(true);
    try {
      let assetId: string;
      let seconds: number;
      if (isMockApi()) {
        assetId = `ast_vo_${Date.now().toString(36)}`;
        seconds = 4;
      } else {
        const up = uploadToAssets([file], { projectId: input.project.id, purpose: 'library' });
        if (!up.items[0]) throw new Error(t('post.voiceover.refused'));
        const pick = await up.items[0].done;
        assetId = pick.assetId;
        seconds = pick.durationSec ?? (await audioLength(file)) ?? 5;
        await attestVoiceRights(assetId);
      }
      const clipId = place(assetId, seconds);
      toast.show({ message: t('post.voiceover.added') });
      onClose();
      // The transcript (for the agent's pacing and later captions) is free; it runs on its own.
      if (input.real && clipId) void runCaptions(input.project.id, input.edl, { source: { kind: 'clip', clipId }, language: 'auto', transcriptOnly: true }, () => {}, () => {}).catch(() => {});
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : t('post.failed') });
    } finally {
      setBusy(false);
    }
  };

  const record = async () => {
    if (recording) return rec.current?.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream);
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      setRecording(false);
      const type = r.mimeType || 'audio/webm';
      void take(new File(chunks, `voiceover.${type.includes('ogg') ? 'ogg' : 'webm'}`, { type: type.split(';')[0] }));
    };
    rec.current = r;
    r.start();
    setRecording(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.voiceover.title')} closeLabel={t('post.close')} width={440}>
      <div className={styles.body} data-testid="voiceover-dialog">
        <p className={styles.note}>{t('post.voiceover.note')}</p>
        <label className={styles.check}>
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} data-testid="voice-rights" />
          <span>{t('post.rights')}</span>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/webm,.mp3,.wav,.m4a,.aac,.ogg"
          hidden
          data-testid="voiceover-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void take(f);
          }}
        />
        {recording ? (
          <p className={styles.rec} role="status">
            <span className={styles.recDot} aria-hidden="true" />
            {t('post.voiceover.recording')}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} onClick={onClose}>
            {t('post.cancel')}
          </button>
          {canRecord ? (
            <button type="button" className={`${eStyles.btn} ${eStyles.secondary}`} disabled={!rights || busy} onClick={() => void record().catch(() => toast.show({ message: t('post.voiceover.noMic') }))}>
              {t(recording ? 'post.voiceover.stop' : 'post.voiceover.record')}
            </button>
          ) : null}
          <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} disabled={!rights || busy || recording} onClick={() => fileRef.current?.click()}>
            {t('post.voiceover.choose')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function audioLength(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(a.duration) ? a.duration : null);
    };
    a.onerror = () => resolve(null);
    a.src = url;
  });
}

/** Reframing of a shot for exports in another aspect ratio: follow the subject (auto), center, or a fixed point. */
function ReframeDialog({ open, onClose, input, shot }: { open: boolean; onClose: () => void; input: PostProductionInput; shot: MediaClip }) {
  const { t } = useT();
  const mode = shot.reframe?.mode ?? 'auto';
  const [x, setX] = useState(shot.reframe?.x ?? 0.5);
  const set = (reframe: Reframe | null) => input.commit([{ op: 'setReframe', clipId: shot.id, reframe }]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('post.reframe.title')} closeLabel={t('post.close')} width={420}>
      <div className={styles.body} data-testid="reframe-dialog">
        <p className={styles.note}>{t('post.reframe.note')}</p>
        <SegmentedControl
          label={t('post.reframe.title')}
          value={mode}
          onValueChange={(v) => set(v === 'auto' ? null : v === 'center' ? { mode: 'center' } : { mode: 'manual', x, y: 0.5 })}
          options={(['auto', 'center', 'manual'] as const).map((m) => ({ value: m, label: t(`post.reframe.${m}`) }))}
        />
        {mode === 'manual' ? (
          <label className={styles.row}>
            <span className={styles.label}>{t('post.reframe.position')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={x}
              aria-label={t('post.reframe.position')}
              onChange={(e) => setX(Number(e.target.value))}
              onPointerUp={() => set({ mode: 'manual', x, y: 0.5 })}
              onKeyUp={() => set({ mode: 'manual', x, y: 0.5 })}
            />
          </label>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={`${eStyles.btn} ${eStyles.primary}`} onClick={onClose}>
            {t('post.close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
