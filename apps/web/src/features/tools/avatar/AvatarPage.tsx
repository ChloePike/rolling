import { useToast } from '@rolling/ui';
import { useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import controls from '../shared/controls.module.css';
import { ToolIcon } from '../shared/icons';
import layout from '../shared/ToolLayout.module.css';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import { PickPopover } from '../shared/PickPopover';
import { useFilePicker } from '../shared/useFilePicker';
import type { FeedItem, ScriptDraft } from '../types';
import { useCreationMode } from '@/lib/prefs';
import { quoteCredits, segModels, useToolModels } from '../shared/useToolModels';
import type { PlanId } from '@rolling/core/pricing/config';
import type { ToolModel } from '../shared/models';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import type { ComposerPill } from '../types';
import styles from './Avatar.module.css';
import { avatarClone, avatarLookOptions, avatarLooks, avatarPersonas, avatarPrompt, avatarVoices } from './mocks';

const RES_COST: Record<string, number> = { '480p': 6, '720p': 10, '1080p': 18 };
/** Lip-sync methods; "Wan 2.2 S2V" runs on the `lumina/wan2.7-i2v-spicy` candidate (D-002). */
/** Short list for the Advanced "Model" control (design order), by catalog id. */
const SEG_IDS = ['minimax/minimax-h3', 'lumina/wan2.7-i2v-spicy'];
const EMOTIONS = ['calm', 'warm', 'upbeat', 'serious'];

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
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  const models = useToolModels('avatar', modelsOverride);
  const segOptions = ['Auto', ...segModels(models, SEG_IDS).map((m) => m.name)];
  const rawFeed = useToolFeed('avatar');
  const [p, setP] = useState({ model: 'Auto', rate: 1, emo: 'warm', pause: 0.4, bg: 'background', camText: '', res: '720p', count: '1', seed: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const [persona, setPersona] = useState('Expert presenter');
  const [voice, setVoice] = useState('Clear female');
  const [text, setText] = useState(avatarPrompt);
  const feed = rawFeed;
  const mapItem = (f: FeedItem): FeedItem =>
    f.kind === 'draft' ? { ...f, title: t('tools.avatar.draft.title'), meta: t('tools.avatar.draft.meta', { persona, voice, sec: 9, of: 10 }) } : f;
  const toast = useToast();
  const [looks, setLooks] = useState<Record<string, string>>(() => Object.fromEntries(avatarLooks.map((x) => [x.id, x.value])));
  const [lookTarget, setLookTarget] = useState<string | null>(null);
  const lookPicker = useFilePicker('image/*', (file) => {
    if (!lookTarget) return;
    setLooks((cur) => ({ ...cur, [lookTarget]: t('tools.avatar.look.uploaded', { file: file.name }) }));
    toast.show({ message: t('tools.toast.presetUploaded', { file: file.name }) });
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const [customPersonas, setCustomPersonas] = useState<Array<[string, string]>>([]);
  const personas = [...avatarPersonas, ...customPersonas];
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
  const rewrite = (d: ScriptDraft): ScriptDraft => {
    const i = personas.findIndex(([n]) => n === persona);
    const [nextName, nextLine] = personas[(i + 1) % personas.length]!;
    setPersona(nextName);
    return { ...d, lines: d.lines.map((l, k) => (k === 1 ? { ...l, text: nextLine } : l)) };
  };
  const example = (personas.find(([n]) => n === persona) ?? avatarPersonas[0]!)[1];
  const fixed = (v: number, d: number) => intl.formatNumber(v, { minimumFractionDigits: d, maximumFractionDigits: d });

  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.avatar.adv.method'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    { kind: 'slider', id: 'rate', title: t('tools.avatar.adv.pace'), icon: 'wave', min: 0.8, max: 1.3, step: 0.05, value: p.rate, display: t('tools.rate', { v: fixed(p.rate, 2) }), low: t('tools.adv.slow'), high: t('tools.adv.fast'), onChange: (v) => set('rate', v) },
    { kind: 'seg', id: 'emo', title: t('tools.avatar.adv.emotion'), icon: 'person', options: EMOTIONS.map((e) => ({ value: e, label: t(`tools.avatar.emotion.${e}`) })), value: p.emo, onChange: (v) => set('emo', v) },
    { kind: 'slider', id: 'pause', title: t('tools.avatar.adv.pause'), icon: 'clock', min: 0, max: 1, step: 0.1, value: p.pause, display: t('tools.secondsFrac', { v: fixed(p.pause, 1) }), low: t('tools.avatar.adv.pause.low'), high: t('tools.avatar.adv.pause.high'), onChange: (v) => set('pause', v) },
    { kind: 'seg', id: 'bg', title: t('tools.avatar.adv.setting'), icon: 'scene', options: [{ value: 'background', label: t('tools.avatar.adv.setting.background') }, { value: 'reference', label: t('tools.avatar.adv.setting.reference') }], value: p.bg, onChange: (v) => set('bg', v) },
    { kind: 'text', id: 'camText', title: t('tools.avatar.adv.camera'), icon: 'cam', value: p.camText, placeholder: t('tools.avatar.adv.camera.placeholder'), onChange: (v) => set('camText', v) },
    { kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', ['480p', '720p', '1080p']), value: p.res, onChange: (v) => set('res', v) },
    { kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: ['1', '2'].map((v) => ({ value: v, label: v })), value: p.count, onChange: (v) => set('count', v) },
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
  ];

  const pills: ComposerPill[] = adv
    ? [
        { id: 'model', label: p.model === 'Auto' ? t('tools.model.auto') : p.model, icon: 'cube' },
        { id: 'camera', label: t('tools.avatar.pill.camera'), icon: 'cam' },
        { id: 'ratio', label: '9:16', icon: 'ratio' },
        { id: 'duration', label: t('tools.seconds', { n: 10 }), icon: 'clock' },
        { id: 'res', label: p.res, icon: 'res' },
        { id: 'pace', label: t('tools.avatar.pill.pace', { v: fixed(p.rate, 2) }), icon: 'wave' },
        { id: 'emotion', label: t(`tools.avatar.emotion.${p.emo}`), icon: 'person' },
      ]
    : [
        { id: 'model', label: t('tools.model.auto'), icon: 'cube' },
        { id: 'camera', label: t('tools.avatar.pill.camera'), icon: 'cam' },
        { id: 'ratio', label: '9:16', icon: 'ratio' },
        { id: 'duration', label: t('tools.seconds', { n: 10 }), icon: 'clock' },
        { id: 'audio', label: t('tools.pill.audio'), icon: 'wave' },
      ];
  const cost =
    quoteCredits(models, adv ? p.model : 'Auto', { resolution: adv ? p.res : '720p', seconds: 10, count: adv ? Number(p.count) : 1 }) ??
    (adv ? RES_COST[p.res]! : 10) + 2;
  const go = t('tools.avatar.go');

  const aside = (
    <>
      <AsideCard title={t('tools.avatar.look')} testId="look">
        {lookPicker.input}
        {avatarLooks.map((x) => (
          <PickPopover
            key={x.id}
            label={t(`tools.avatar.look.${x.id}`)}
            value={looks[x.id]!}
            options={avatarLookOptions[x.id].map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              setLooks((cur) => ({ ...cur, [x.id]: v }));
              toast.show({ message: t('tools.toast.presetSet', { name: t(`tools.avatar.look.${x.id}`), value: v }) });
            }}
            extra={{ label: t('tools.remix.preset.upload'), onSelect: () => (setLookTarget(x.id), lookPicker.open()) }}
            trigger={(tp) => (
              <button {...tp} type="button" className={controls.pickRow} style={{ flex: 1 }} data-look={x.id}>
                <span className={controls.pickThumb} style={{ background: x.tone }} />
                <span className={controls.pickText}>
                  <span className={controls.pickLabel}>{t(`tools.avatar.look.${x.id}`)}</span>
                  <span className={controls.pickValue}>{looks[x.id]}</span>
                </span>
                <span className={controls.chev}>›</span>
              </button>
            )}
          />
        ))}
      </AsideCard>
      <AsideCard title={t('tools.avatar.persona')} hint={t('tools.avatar.persona.hint')} testId="persona">
        <div className={controls.chips}>
          {personas.map(([name, eg]) => (
            <button key={name} type="button" className={controls.chip} aria-pressed={persona === name} title={eg} onClick={() => setPersona(name)}>
              {name}
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
              setCustomPersonas((c) => [...c, [name, t('tools.avatar.persona.customExample', { name })]]);
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
        <div className={styles.example}>
          <FormattedMessage id="tools.avatar.persona.example" values={{ text: example }} />
        </div>
      </AsideCard>
      <AsideCard
        title={t('tools.avatar.voice')}
        testId="voice"
        end={
          <select aria-label={t('tools.avatar.voice.language')} className={layout.select} value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}>
            <option value="en">English</option>
            <option value="yue">Cantonese</option>
            <option value="en-2">English</option>
          </select>
        }
      >
        {avatarVoices.map(([name, desc]) => (
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
            <span className={styles.cloneName}>{avatarClone.name}</span>
            <span className={styles.clonePct}>
              <FormattedMessage id="tools.avatar.cloning" values={{ pct: avatarClone.progress / 100 }} />
            </span>
          </div>
          <div
            className={styles.track}
            role="progressbar"
            aria-valuenow={avatarClone.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('tools.avatar.cloning.label', { name: avatarClone.name })}
          >
            <div className={styles.fill} style={{ width: `${avatarClone.progress}%` }} />
          </div>
        </div>
      </AsideCard>
    </>
  );

  return (
    <ToolLayout
      testId="tool-avatar"
      title={t('tools.avatar.title')}
      count={(f) => t('tools.results', { n: f.filter((x) => x.kind === 'media').length })}
      mapItem={mapItem}
      onRewriteDraft={rewrite}
      feedMin={210}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      composer={{
        noteLead: t('tools.avatar.note'),
        noteChips: [t('tools.avatar.note.exact', { n: 1 }), t('tools.avatar.note.gestures', { n: 3 })],
        refs: [{ badge: '@Advisor', tone: 'var(--c-tone-teal)' }],
        label: t('tools.avatar.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.avatar.composer.placeholder'),
        pills,
        cost,
        goLabel: go,
      }}
      models={models}
      pickerKind="avatar"
      paramKind="video"
      model={p.model}
      onModel={(m) => set('model', m)}
      confirm={{ cost, label: go }}
      run={{
        aspect: '9/16',
        video: true,
        tags: ['9:16', t('tools.seconds', { n: 10 }), voice],
        tiles: [],
        steps: [t('tools.run.step.script'), t('tools.run.step.tts')],
        generating: (n) => t('tools.run.step.lipSync', { pct: n / 100 }),
        durationSec: 10,
      }}
      actions={['redo', 'sliders', 'frame', 'down', 'star']}
      viewerAspect="9/16"
      initialOverlay={initialOverlay}
      isMember={isMember}
      plan={plan}
    />
  );
}
