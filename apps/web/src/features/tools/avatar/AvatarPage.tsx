import { useToast } from '@rolling/ui';
import type { PlanId } from '@rolling/core/pricing/config';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isMockApi, mockData } from '@/lib/api/mode';
import { useCreationMode } from '@/lib/prefs';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import controls from '../shared/controls.module.css';
import { ToolIcon } from '../shared/icons';
import { AssetRow, LibraryRow, type LibraryPick } from '../shared/LibraryPicker';
import type { ToolModel } from '../shared/models';
import { settingsPills, settingsTags } from '../shared/pills';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import { avatarHints } from '../shared/promptHints';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { useToolSettings } from '../shared/settings';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import layout from '../shared/ToolLayout.module.css';
import { modelIdOf, segModels, useToolModels } from '../shared/useToolModels';
import type { ComposerPill, FeedItem, ScriptDraft } from '../types';
import styles from './Avatar.module.css';

const EMOTIONS = ['calm', 'warm', 'upbeat', 'serious'];
/** Presenting styles (prompt direction, `avatarHints`); names in messages. */
const PERSONAS = ['expert', 'lifestyle', 'host', 'teacher', 'anchor', 'companion', 'comedian', 'storyteller', 'advisor', 'outdoor'];

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); defaults to the session's plan (lib/session). */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the session. */
  isMember?: boolean;
}

export function AvatarPage({ initialOverlay, models: modelsOverride, plan: planProp, isMember }: Props) {
  const plan = useToolPlan(planProp);
  const intl = useIntl();
  const navigate = useNavigate();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  // Mock mode: the design's sample looks, voices and examples, only through the mock adapter.
  const demo = isMockApi() ? mockData().avatar : null;
  const models = useToolModels('avatar', modelsOverride);
  const segOptions = ['Auto', ...segModels(models, demo?.avatarSegIds).map((m) => m.name)];
  const feed = useToolFeed('avatar');
  const [p, setP] = useState({ model: 'Auto', rate: 1, emo: 'warm', pause: 0.4, bg: 'background', camText: '', count: '1', seed: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const model = adv ? p.model : 'Auto';
  const settings = useToolSettings(models, model, 'avatar', demo?.avatarSettings);
  const s = settings.value;
  const caps = settings.caps;
  const personaName = (id: string) => (PERSONAS.includes(id) ? t(`tools.avatar.persona.${id}`) : id);
  const [persona, setPersona] = useState('expert');
  const [voice, setVoice] = useState(() => demo?.avatarVoices[0]?.[0] ?? '');
  const [text, setText] = useState(demo?.avatarPrompt ?? '');
  const mapItem = (f: FeedItem): FeedItem =>
    f.kind === 'draft' ? { ...f, title: t('tools.avatar.draft.title'), meta: t('tools.avatar.draft.meta', { persona: personaName(persona), voice, sec: 9, of: 10 }) } : f;
  const toast = useToast();
  /** The photo that speaks (an asset: an upload, a Character or a library portrait) and the scene (a library item or an asset). */
  const [portrait, setPortrait] = useState<LibraryPick | null>(null);
  const [scene, setScene] = useState<LibraryPick | null>(null);
  /** The voice track: an audio asset from the user's Assets (uploaded from the picker if new). */
  const [track, setTrack] = useState<{ id: string; name: string; seconds: number | null } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const [customPersonas, setCustomPersonas] = useState<string[]>([]);
  const personas = [...PERSONAS, ...customPersonas];
  const [voiceLang, setVoiceLang] = useState('en');
  const [playing, setPlaying] = useState<string | null>(null);
  const playTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(playTimer.current), []);
  const preview = (name: string) => {
    window.clearTimeout(playTimer.current);
    if (playing === name) return setPlaying(null);
    setPlaying(name);
    playTimer.current = window.setTimeout(() => setPlaying(null), 2500);
  };
  /** Mock mode only: the design's example line per persona. */
  const exampleOf = (id: string) => {
    if (!demo) return null;
    const i = PERSONAS.indexOf(id);
    return i >= 0 ? demo.avatarPersonas[i]![1] : t('tools.avatar.persona.customExample', { name: id });
  };
  const rewrite = (d: ScriptDraft): ScriptDraft => {
    const i = personas.indexOf(persona);
    const next = personas[(i + 1) % personas.length]!;
    setPersona(next);
    const line = exampleOf(next);
    return { ...d, lines: d.lines.map((l, k) => (k === 1 && line ? { ...l, text: line } : l)) };
  };
  const example = exampleOf(persona);
  const fixed = (v: number, d: number) => intl.formatNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d });

  // Only settings a real run uses (the model, resolution, prompt direction, seed); TTS pace and pauses exist for the design's sample model alone.
  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.avatar.adv.method'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    ...(caps.design
      ? ([
          { kind: 'slider', id: 'rate', title: t('tools.avatar.adv.pace'), icon: 'wave', min: 0.8, max: 1.3, step: 0.05, value: p.rate, display: t('tools.rate', { v: fixed(p.rate, 2) }), low: t('tools.adv.slow'), high: t('tools.adv.fast'), onChange: (v) => set('rate', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    { kind: 'seg', id: 'emo', title: t('tools.avatar.adv.emotion'), icon: 'person', options: EMOTIONS.map((e) => ({ value: e, label: t(`tools.avatar.emotion.${e}`) })), value: p.emo, onChange: (v) => set('emo', v) },
    ...(caps.design
      ? ([
          { kind: 'slider', id: 'pause', title: t('tools.avatar.adv.pause'), icon: 'clock', min: 0, max: 1, step: 0.1, value: p.pause, display: t('tools.secondsFrac', { v: fixed(p.pause, 1) }), low: t('tools.avatar.adv.pause.low'), high: t('tools.avatar.adv.pause.high'), onChange: (v) => set('pause', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    { kind: 'seg', id: 'bg', title: t('tools.avatar.adv.setting'), icon: 'scene', options: [{ value: 'background', label: t('tools.avatar.adv.setting.background') }, { value: 'reference', label: t('tools.avatar.adv.setting.reference') }], value: p.bg, onChange: (v) => set('bg', v) },
    { kind: 'text', id: 'camText', title: t('tools.avatar.adv.camera'), icon: 'cam', value: p.camText, placeholder: t('tools.avatar.adv.camera.placeholder'), onChange: (v) => set('camText', v) },
    ...(caps.resolutions.length
      ? [{ kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', caps.resolutions), value: s.resolution, onChange: (v: string) => settings.set({ ...s, resolution: v }) } satisfies SettingsGroupDef]
      : []),
    ...(caps.design
      ? ([{ kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: ['1', '2'].map((v) => ({ value: v, label: v })), value: p.count, onChange: (v) => set('count', v) }] satisfies SettingsGroupDef[])
      : []),
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
  ];

  // The run lasts as long as the voice track (mock mode: the design's 10s).
  const seconds = track?.seconds != null ? Math.max(1, Math.ceil(track.seconds)) : (demo?.avatarSeconds ?? 0);
  const camLabel = p.camText.trim() ? (p.camText.trim().length > 24 ? `${p.camText.trim().slice(0, 23)}…` : p.camText.trim()) : demo ? t('tools.avatar.pill.camera') : null;
  const pills: ComposerPill[] = [
    { id: 'model', label: model === 'Auto' ? t('tools.model.auto') : model, icon: 'cube' },
    ...(camLabel ? [{ id: 'camera', label: camLabel, icon: 'cam' } as ComposerPill] : []),
    ...settingsPills(intl, { ...s, seconds: 0 }, caps).filter((x) => x.id === 'ratio'),
    ...(seconds ? [{ id: 'duration', label: t('tools.seconds', { n: seconds }), icon: 'clock' } as ComposerPill] : []),
    // The design's Simple mode shows no resolution pill; real mode always shows what the run sends.
    ...((adv || !caps.design) && caps.resolutions.length && s.resolution ? [{ id: 'res', label: s.resolution, icon: 'res' } as ComposerPill] : []),
    ...(!adv && caps.design ? [{ id: 'audio', label: t('tools.pill.audio'), icon: 'wave' } as ComposerPill] : []),
    ...(adv && caps.design ? [{ id: 'pace', label: t('tools.avatar.pill.pace', { v: fixed(p.rate, 2) }), icon: 'wave' } as ComposerPill] : []),
    ...(adv ? [{ id: 'emotion', label: t(`tools.avatar.emotion.${p.emo}`), icon: 'person' } as ComposerPill] : []),
  ];
  const go = t('tools.avatar.go');
  const tags = [...settingsTags(intl, { ...s, seconds }), ...(demo ? [voice] : track ? [track.name] : [])];

  const aside = (
    <>
      <AsideCard title={t('tools.avatar.look')} testId="look">
        <LibraryRow
          testId="character"
          attr="look"
          label={t('tools.avatar.look.character')}
          categories={['portrait']}
          kinds={['image', 'character']}
          icon="person"
          tone="var(--c-tone-teal)"
          value={portrait}
          fallback={demo?.avatarLooks[0].value ?? t('tools.avatar.photo.empty')}
          onChange={(item) => {
            setPortrait(item);
            if (item) toast.show({ message: t('tools.toast.presetSet', { name: t('tools.avatar.look.character'), value: item.title }) });
          }}
        />
        <LibraryRow
          testId="scene"
          attr="look"
          label={t('tools.avatar.look.scene')}
          categories={['scene', 'lighting', 'furniture', 'prop']}
          icon="scene"
          tone="var(--c-tone-indigo)"
          value={scene}
          fallback={demo?.avatarLooks[1].value ?? t('tools.avatar.scene.photo')}
          onChange={(item) => {
            setScene(item);
            if (item) toast.show({ message: t('tools.toast.presetSet', { name: t('tools.avatar.look.scene'), value: item.title }) });
          }}
        />
      </AsideCard>
      <AsideCard title={t('tools.avatar.persona')} hint={t('tools.avatar.persona.hint')} testId="persona">
        <div className={controls.chips}>
          {personas.map((id) => (
            <button key={id} type="button" className={controls.chip} aria-pressed={persona === id} title={exampleOf(id) ?? undefined} onClick={() => setPersona(id)}>
              {personaName(id)}
            </button>
          ))}
          <button type="button" className={styles.custom} aria-expanded={customOpen} onClick={() => setCustomOpen((v) => !v)}>
            <FormattedMessage id="tools.avatar.persona.custom" />
          </button>
        </div>
        {customOpen && (
          <form
            className={styles.customForm}
            onSubmit={(e) => {
              e.preventDefault();
              const name = customText.trim();
              if (!name) return;
              setCustomPersonas((c) => [...c, name]);
              setPersona(name);
              setCustomText('');
              setCustomOpen(false);
            }}
          >
            <input
              autoFocus
              className={styles.customInput}
              aria-label={t('tools.avatar.persona.customLabel')}
              placeholder={t('tools.avatar.persona.customPlaceholder')}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
            />
            <button type="submit" className={styles.customAdd} disabled={!customText.trim()}>
              <FormattedMessage id="tools.avatar.persona.add" />
            </button>
          </form>
        )}
        {example && (
          <div className={styles.example}>
            <FormattedMessage id="tools.avatar.persona.example" values={{ text: example }} />
          </div>
        )}
      </AsideCard>
      <AsideCard
        title={t('tools.avatar.voice')}
        testId="voice"
        end={
          demo ? (
            <select aria-label={t('tools.avatar.voice.language')} className={layout.select} value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}>
              <option value="en">English</option>
              <option value="yue">Cantonese</option>
              <option value="en-2">English</option>
            </select>
          ) : undefined
        }
      >
        {demo ? (
          <>
            {demo.avatarVoices.map(([name, desc]) => (
              <div key={name} className={voice === name ? `${styles.voice} ${styles.voiceOn}` : styles.voice}>
                <button type="button" className={styles.preview} aria-label={t('tools.avatar.voice.preview', { name })} aria-pressed={playing === name} onClick={() => preview(name)}>
                  <ToolIcon name={playing === name ? 'volume' : 'play'} size={11} filled={playing !== name} color="var(--c-text-1)" />
                </button>
                <button type="button" className={styles.voicePick} aria-pressed={voice === name} onClick={() => setVoice(name)}>
                  <span className={styles.voiceName}>{name}</span>
                  <span className={styles.voiceDesc}>{desc}</span>
                </button>
              </div>
            ))}
            <div className={styles.clone}>
              <div className={styles.cloneHead}>
                <ToolIcon name="mic" size={15} color="var(--c-accent)" />
                <span className={styles.cloneName}>{demo.avatarClone.name}</span>
                <span className={styles.clonePct}>
                  <FormattedMessage id="tools.avatar.cloning" values={{ pct: demo.avatarClone.progress / 100 }} />
                </span>
              </div>
              <div
                className={styles.track}
                role="progressbar"
                aria-valuenow={demo.avatarClone.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('tools.avatar.cloning.label', { name: demo.avatarClone.name })}
              >
                <div className={styles.fill} style={{ width: `${demo.avatarClone.progress}%` }} />
              </div>
            </div>
          </>
        ) : (
          // The TTS / voice-clone provider is an open decision: no built-in voices yet; runs lip-sync to an uploaded track.
          <>
            <p className={styles.example} data-voice-unavailable="">
              <FormattedMessage id="tools.avatar.voice.unavailable" />
            </p>
            <AssetRow
              label={t('tools.avatar.voice.upload')}
              kinds={['audio']}
              icon="mic"
              tone="var(--c-tone-plum)"
              value={track ? { name: track.seconds !== null ? t('tools.avatar.voice.track', { file: track.name, sec: Math.round(track.seconds) }) : track.name } : null}
              empty={t('tools.avatar.voice.hint')}
              attrs={{ 'data-voice-upload': '' }}
              onChange={(pick) => {
                setTrack({ id: pick.assetId, name: pick.name, seconds: pick.durationSec ?? null });
                toast.show({ message: t('tools.avatar.voice.added', { file: pick.name }) });
              }}
            />
          </>
        )}
      </AsideCard>
    </>
  );

  return (
    <ToolLayout
      testId="tool-avatar"
      toolId="avatar"
      title={t('tools.avatar.title')}
      count={(f) => t('tools.results', { n: f.filter((x) => x.kind === 'media').length })}
      mapItem={mapItem}
      onRewriteDraft={rewrite}
      feedMin={210}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      settings={{ value: s, caps, onChange: settings.set, onReset: settings.reset }}
      composer={{
        noteLead: t('tools.avatar.note'),
        noteChips: demo ? [t('tools.avatar.note.exact', { n: 1 }), t('tools.avatar.note.gestures', { n: 3 })] : [],
        refs: demo ? [{ badge: '@Advisor', tone: 'var(--c-tone-teal)' }] : portrait ? [{ badge: `@${t('tools.avatar.look.character')}`, tone: 'var(--c-tone-teal)' }] : [],
        label: t('tools.avatar.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.avatar.composer.placeholder'),
        pills,
        goLabel: go,
      }}
      models={models}
      pickerKind="avatar"
      paramKind="video"
      model={model}
      onModel={(m) => set('model', m)}
      confirm={{ cost: demo ? demo.avatarMockCost({ adv, res: s.resolution }) : 0, label: go }}
      run={{
        aspect: s.ratio && s.ratio !== 'Auto' ? s.ratio.replace(':', '/') : '9/16',
        video: true,
        tags,
        tiles: [],
        steps: [t('tools.run.step.script'), t('tools.run.step.tts')],
        generating: (n) => t('tools.run.step.lipSync', { pct: n / 100 }),
        generatingIdle: t('tools.run.step.lipSyncNoProgress'),
        durationSec: seconds || undefined,
      }}
      actions={['redo', 'sliders', 'frame', 'down', 'star']}
      spec={(prompt) => {
        const photoId = portrait?.assetId;
        if (!photoId) return t('tools.avatar.needPhoto');
        if (!track) return t('tools.avatar.needVoice');
        const setting = adv && p.bg === 'reference' ? { keepPhoto: true as const } : scene ? { scene: scene.promptEn || scene.title } : { keepPhoto: true as const };
        return {
          kind: 'avatar',
          model: modelIdOf(models, model),
          prompt: [prompt.trim(), adv && p.camText.trim() ? p.camText.trim() : '', ...avatarHints({ persona: personaName(persona), ...(adv ? { emotion: t(`tools.avatar.emotion.${p.emo}`) } : {}), setting })]
            .filter(Boolean)
            .join(' '),
          title: t('tools.avatar.title'),
          ...(s.ratio && s.ratio !== 'Auto' ? { ratio: s.ratio } : {}),
          ...(s.resolution ? { resolution: s.resolution } : {}),
          ...(adv && /^\d+$/.test(p.seed) ? { seed: Number(p.seed) } : {}),
          ...(seconds ? { seconds } : {}),
          inputs: { photoAssetId: photoId, audioAssetId: track.id },
        };
      }}
      viewerAspect="9/16"
      initialOverlay={initialOverlay}
      isMember={isMember}
      plan={plan}
    />
  );
}
