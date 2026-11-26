import { useToast } from '@rolling/ui';
import type { LibraryCategoryKey } from '@rolling/core/library/types';
import type { PlanId } from '@rolling/core/pricing/config';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { isMockApi, mockData } from '@/lib/api/mode';
import { useCreationMode } from '@/lib/prefs';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import controls from '../shared/controls.module.css';
import { ToolIcon, type ToolIconName } from '../shared/icons';
import { AssetRow, LibraryRow, type LibraryPick } from '../shared/LibraryPicker';
import type { ToolModel } from '../shared/models';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import { remixHints, shotPrompt } from '../shared/promptHints';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { useToolSettings } from '../shared/settings';
import { settingsPills, settingsTags } from '../shared/pills';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import { usePickAsset } from '../shared/usePickAsset';
import { modelIdOf, segModels, TOOL_NEEDS, useToolModels } from '../shared/useToolModels';
import type { ComposerPill } from '../types';
import styles from './Remix.module.css';

/** Preset rows and the public-library categories behind each (D-004). */
const PRESETS: Array<{ id: 'action' | 'outfit' | 'scene'; icon: ToolIconName; tone: string; categories: LibraryCategoryKey[] }> = [
  { id: 'action', icon: 'body', tone: 'var(--c-tone-teal)', categories: ['pose', 'pose_depth'] },
  { id: 'outfit', icon: 'shirt', tone: 'var(--c-tone-sand)', categories: ['outfit', 'outfit_anime', 'outfit_historical'] },
  { id: 'scene', icon: 'scene', tone: 'var(--c-tone-indigo)', categories: ['scene', 'lighting', 'prop', 'furniture'] },
];
type PresetId = (typeof PRESETS)[number]['id'];
const SLOT_TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-sand)', 'var(--c-tone-neutral)'];

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); defaults to the session's plan (lib/session). */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the session. */
  isMember?: boolean;
}

export function RemixPage({ initialOverlay, models: modelsOverride, plan: planProp, isMember }: Props) {
  const plan = useToolPlan(planProp);
  const intl = useIntl();
  const navigate = useNavigate();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  // Mock mode: the design's sample content, only through the mock adapter.
  const demo = isMockApi() ? mockData().remix : null;
  const models = useToolModels('video', modelsOverride, TOOL_NEEDS.remix);
  const segOptions = ['Auto', ...segModels(models, demo?.remixSegIds).map((m) => m.name)];
  const feed = useToolFeed('remix');
  const [p, setP] = useState({ model: 'Auto', motion: 6, refw: 80, outfit: 'all', fps: '24', seed: '', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const model = adv ? p.model : 'Auto';
  const settings = useToolSettings(models, model, 'video', demo?.remixSettings);
  const s = settings.value;
  const caps = settings.caps;
  const [people, setPeople] = useState(2);
  const [text, setText] = useState(demo?.remixPrompt ?? '');
  const toast = useToast();
  /** Items picked per preset row (public library or the user's assets, uploads included). */
  const [picked, setPicked] = useState<Partial<Record<PresetId, LibraryPick>>>({});
  /** Character slots: the asset that gives each character its look. */
  const [uploads, setUploads] = useState<Record<number, { id: string | null; name: string }>>({});
  /** The reference video: a video asset from the user's Assets. */
  const [video, setVideo] = useState<{ id: string; name: string } | null>(null);
  /** The shot fields the user writes (camera, line, actions), keyed by field id. */
  const [shot, setShot] = useState<Record<string, string>>({});
  const [slotTarget, setSlotTarget] = useState<number | null>(null);
  const slotPicker = usePickAsset({ kinds: ['image', 'character'], categories: ['portrait'], tab: 'mine' }, (pick) => {
    if (slotTarget === null) return;
    setUploads((u) => ({ ...u, [slotTarget]: { id: pick.assetId, name: pick.name } }));
    toast.show({ message: t('tools.toast.slotUploaded', { name: charName(slotTarget), file: pick.name }) });
  });

  const charName = (i: number) => t('tools.remix.character', { n: i + 1 });
  const sample = (i: number) => demo?.remixSampleCast[i];
  const slots = Array.from({ length: people }, (_, i) => {
    const up = uploads[i];
    const s0 = sample(i);
    return {
      name: charName(i),
      tone: up || s0 ? SLOT_TONES[i]! : 'var(--c-surface-3)',
      placeholder: up || s0 ? '' : t('tools.remix.slot.placeholder'),
      state: up?.name ?? (s0 === 'template' ? t('tools.remix.slot.template') : s0 === 'uploaded' ? t('tools.remix.slot.uploaded') : t('tools.remix.slot.notSet')),
      set: !!up || !!s0,
    };
  });
  /** Characters with a look: the only ones an outfit can apply to. */
  const cast = slots.map((x, i) => ({ ...x, i })).filter((x) => x.set);

  /** Shot fields: the design's parsed sample in mock mode, else what the user types (sent as `shots[0].prompt`). */
  const shotFields: Array<{ id: string; label: string; placeholder: string }> = [
    { id: 'camera', label: t('tools.remix.parsed.camera'), placeholder: t('tools.remix.shot.placeholder.camera') },
    { id: 'line1', label: t('tools.remix.parsed.line', { n: 1 }), placeholder: t('tools.remix.shot.placeholder.line') },
    ...Array.from({ length: people }, (_, i) => ({ id: `action${i + 1}`, label: t('tools.remix.parsed.action', { n: i + 1 }), placeholder: t('tools.remix.shot.placeholder.action') })),
  ];
  const parsed: Array<[string, string]> | null = demo
    ? [
        [t('tools.remix.parsed.camera'), demo.remixParsed.camera],
        [t('tools.remix.parsed.line', { n: 1 }), demo.remixParsed.line1],
        [t('tools.remix.parsed.action', { n: 1 }), demo.remixParsed.action1],
        [t('tools.remix.parsed.action', { n: 2 }), demo.remixParsed.action2],
        ...Array.from({ length: Math.max(0, people - 2) }, (_, k) => [t('tools.remix.parsed.actionExtra', { n: k + 3 }), t('tools.remix.parsed.idle')] as [string, string]),
      ]
    : null;
  const filled = (prefix: string) => shotFields.filter((f) => f.id.startsWith(prefix) && (shot[f.id] ?? '').trim()).length;
  const noteChips = demo
    ? [t('tools.remix.note.camera', { n: 1 }), t('tools.remix.note.lines', { n: 1 }), t('tools.remix.note.actions', { n: people })]
    : [
        ...(filled('camera') ? [t('tools.remix.note.camera', { n: filled('camera') })] : []),
        ...(filled('line') ? [t('tools.remix.note.lines', { n: filled('line') })] : []),
        ...(filled('action') ? [t('tools.remix.note.actions', { n: filled('action') })] : []),
      ];

  const pct = (v: number) => intl.formatNumber(v / 100, { style: 'percent' });
  // Only settings with a run parameter behind them; the design's extra controls exist for the sample model alone.
  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    ...(caps.resolutions.length
      ? [{ kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', caps.resolutions), value: s.resolution, onChange: (v: string) => settings.set({ ...s, resolution: v }) } satisfies SettingsGroupDef]
      : []),
    ...(caps.design
      ? ([
          { kind: 'slider', id: 'motion', title: t('tools.adv.motion'), icon: 'motion', min: 1, max: 10, step: 1, value: p.motion, display: t('tools.outOf10', { n: p.motion }), low: t('tools.adv.motion.low'), high: t('tools.adv.motion.high'), onChange: (v) => set('motion', v) },
          { kind: 'slider', id: 'refw', title: t('tools.adv.refWeight'), icon: 'ref', min: 0, max: 100, step: 5, value: p.refw, display: pct(p.refw), low: t('tools.adv.refWeight.low'), high: t('tools.adv.refWeight.high'), onChange: (v) => set('refw', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    // "Apply outfit to": the characters this remix has; hidden until one is added.
    ...(cast.length && (picked.outfit || demo)
      ? [
          {
            kind: 'seg', id: 'outfit', title: t('tools.adv.outfit'), icon: 'shirt',
            options: [{ value: 'all', label: t('tools.adv.outfit.all') }, ...cast.map((c) => ({ value: String(c.i), label: c.name }))],
            value: p.outfit, onChange: (v: string) => set('outfit', v),
          } satisfies SettingsGroupDef,
        ]
      : []),
    ...(caps.design
      ? ([
          { kind: 'seg', id: 'fps', title: t('tools.adv.fps'), icon: 'fps', hint: t('tools.adv.fps.hint'), options: ['24', '30'].map((v) => ({ value: v, label: v })), value: p.fps, onChange: (v) => set('fps', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    ...(caps.counts.length > 1
      ? [{ kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: caps.counts.map((v) => ({ value: String(v), label: String(v) })), value: String(s.count), onChange: (v: string) => settings.set({ ...s, count: Number(v) }) } satisfies SettingsGroupDef]
      : []),
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.remix.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  const pills: ComposerPill[] = [
    { id: 'model', label: model === 'Auto' ? t('tools.model.auto') : model, icon: 'cube' },
    ...settingsPills(intl, s, caps, { ratioIcon: 'wide' }),
    ...(adv && caps.design ? [{ id: 'motion', label: t('tools.remix.pill.motion', { n: p.motion }), icon: 'motion' } as ComposerPill] : []),
    ...(adv && caps.counts.length > 1 ? [{ id: 'count', label: t('tools.pill.count', { n: s.count }), icon: 'count' } as ComposerPill] : []),
  ];
  const outfitFor = p.outfit === 'all' || !cast.some((c) => String(c.i) === p.outfit) ? null : charName(Number(p.outfit));
  const go = t('tools.go.video');
  const tags = [...settingsTags(intl, s), t('tools.remix.people', { n: people })];

  const presetValue = (id: PresetId) => picked[id] ?? null;
  const presetFallback = (id: PresetId) => demo?.remixPresets.find((x) => x.id === id)?.value ?? null;

  const aside = (
    <>
      <AsideCard title={t('tools.remix.presets')} testId="presets">
        {slotPicker.element}
        {!demo && (
          <AssetRow
            label={t('tools.remix.video')}
            kinds={['video']}
            icon="play"
            tone="var(--c-tone-slate)"
            value={video}
            empty={t('tools.remix.video.empty')}
            attrs={{ 'data-remix-video': '' }}
            onChange={(pick) => {
              setVideo({ id: pick.assetId, name: pick.name });
              toast.show({ message: t('tools.remix.video.added', { file: pick.name }) });
            }}
          />
        )}
        {PRESETS.map((x) => (
          <LibraryRow
            key={x.id}
            testId={x.id}
            label={t(`tools.remix.preset.${x.id}`)}
            categories={x.categories}
            icon={x.icon}
            tone={x.tone}
            value={presetValue(x.id)}
            fallback={presetFallback(x.id)}
            onChange={(item) => {
              setPicked((cur) => ({ ...cur, [x.id]: item ?? undefined }));
              if (item) toast.show({ message: t('tools.toast.presetSet', { name: t(`tools.remix.preset.${x.id}`), value: item.title }) });
            }}
          />
        ))}
      </AsideCard>
      <AsideCard title={t('tools.remix.characterTitle')} testId="characters">
        <div role="radiogroup" aria-label={t('tools.remix.characters')} className={styles.counts}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={people === n} aria-label={t('tools.remix.people', { n })} title={t('tools.remix.people', { n })} className={styles.countBtn} onClick={() => setPeople(n)}>
              {n}
            </button>
          ))}
        </div>
        <div className={styles.slots}>
          {slots.map((x, i) => (
            <button
              key={x.name}
              type="button"
              className={styles.slot}
              aria-label={t('tools.remix.slot.upload.label', { name: x.name })}
              data-slot={i}
              onClick={() => {
                setSlotTarget(i);
                slotPicker.open({ title: x.name });
              }}
            >
              <span className={styles.slotThumb} style={{ background: x.tone }}>
                {x.placeholder}
              </span>
              <span className={styles.slotName}>@{x.name}</span>
              <span className={styles.slotState} style={{ color: x.set ? 'var(--c-success)' : 'var(--c-text-3)' }}>
                {x.state}
              </span>
            </button>
          ))}
        </div>
      </AsideCard>
      {parsed ? (
        <AsideCard title={t('tools.remix.parsed')} hint={t('tools.remix.parsed.hint')} testId="parsed">
          {parsed.map(([k, v]) => (
            <div key={k} className={styles.field}>
              <span className={styles.fieldK}>{k}</span>
              <span className={styles.fieldV}>{v}</span>
            </div>
          ))}
        </AsideCard>
      ) : (
        <AsideCard title={t('tools.remix.shot')} hint={t('tools.remix.shot.hint')} testId="parsed">
          {shotFields.map((f) => (
            <label key={f.id} className={styles.field}>
              <span className={styles.fieldK}>{f.label}</span>
              <input
                className={styles.fieldInput}
                data-shot-field={f.id}
                value={shot[f.id] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setShot((cur) => ({ ...cur, [f.id]: e.target.value }))}
              />
            </label>
          ))}
        </AsideCard>
      )}
    </>
  );

  return (
    <ToolLayout
      testId="tool-remix"
      toolId="remix"
      title={t('tools.remix.title')}
      count={(f) => t('tools.results', { n: f.length })}
      feedMin={340}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      settings={{ value: s, caps, onChange: settings.set, onReset: settings.reset }}
      composer={{
        noteLead: t('tools.remix.note'),
        noteChips,
        refs: slots.slice(0, demo ? 2 : people).flatMap((x, i) => (x.set ? [{ badge: `@${i + 1}`, tone: x.tone }] : [])),
        label: t('tools.remix.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.remix.composer.placeholder'),
        pills,
        goLabel: go,
      }}
      models={models}
      pickerKind="video"
      paramKind="video"
      model={model}
      onModel={(m) => set('model', m)}
      confirm={{ cost: demo ? demo.remixMockCost({ adv, res: s.resolution, people, count: s.count }) : 0, label: go }}
      run={{
        aspect: s.ratio && s.ratio !== 'Auto' ? s.ratio.replace(':', '/') : '16/9',
        video: true,
        tags,
        tiles: [],
        steps: [t('tools.run.step.tidy'), model === 'Auto' ? t('tools.model.auto') : model],
        generating: (n) => t('tools.run.step.generating', { pct: n / 100 }),
        durationSec: s.seconds || undefined,
      }}
      actions={['redo', 'sliders', 'frame', 'down', 'star']}
      spec={(prompt) => {
        if (!video) return t('tools.remix.needVideo');
        // New looks: the character slots, then the presets (library items or the user's assets), as references (docs/api.md → Runs, remix).
        const presetIds = PRESETS.flatMap((x) => {
          const id = picked[x.id]?.assetId;
          return id ? [id] : [];
        });
        const slotIds = Object.entries(uploads).flatMap(([i, u]) => (Number(i) < people && u.id ? [u.id] : []));
        const referenceAssetIds = [...slotIds, ...presetIds].slice(0, 9);
        const shotLine = shotPrompt(shotFields.map((f) => [f.label, shot[f.id] ?? '']));
        const presetLines = PRESETS.flatMap((x) => {
          const item = picked[x.id];
          return item ? [`${t(`tools.remix.preset.${x.id}`)}: ${item.promptEn || item.title}`] : [];
        });
        return {
          kind: 'remix',
          model: modelIdOf(models, model),
          prompt: [prompt.trim(), ...presetLines, ...(outfitFor ? remixHints({ outfitFor }) : [])].filter(Boolean).join('\n'),
          ...(shotLine ? { shots: [{ prompt: shotLine }] } : {}),
          title: t('tools.remix.title'),
          ...(s.ratio && s.ratio !== 'Auto' ? { ratio: s.ratio } : {}),
          ...(s.seconds ? { seconds: s.seconds } : {}),
          ...(s.resolution ? { resolution: s.resolution } : {}),
          ...(caps.audio ? { audio: s.audio } : {}),
          ...(adv && p.neg.trim() ? { negativePrompt: p.neg.trim() } : {}),
          ...(adv && /^\d+$/.test(p.seed) ? { seed: Number(p.seed) } : {}),
          inputs: { videoAssetId: video.id, ...(referenceAssetIds.length ? { referenceAssetIds } : {}) },
        };
      }}
      viewerAspect="16/9"
      initialOverlay={initialOverlay}
      isMember={isMember}
      plan={plan}
    />
  );
}
