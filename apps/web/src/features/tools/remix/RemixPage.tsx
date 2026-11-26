import { useToast } from '@rolling/ui';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import { remixHints, shotPrompt } from '../shared/promptHints';
import controls from '../shared/controls.module.css';
import { ToolIcon } from '../shared/icons';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import { PickPopover } from '../shared/PickPopover';
import { useFilePicker } from '../shared/useFilePicker';
import { useCreationMode } from '@/lib/prefs';
import { quoteCredits, segModels, useToolModels } from '../shared/useToolModels';
import type { PlanId } from '@rolling/core/pricing/config';
import type { ToolModel } from '../shared/models';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import type { ComposerPill } from '../types';
import { remixParsed, remixPresetOptions, remixPresets, remixPrompt, remixSlotTones } from './mocks';
import styles from './Remix.module.css';
import { isMockApi } from '@/features/overlays/backend';

const RES_COST: Record<string, number> = { '480p': 6, '720p': 10, '1080p': 18 };
/** Short list for the Advanced "Model" control (design order), by catalog id. */
const SEG_IDS = ['bytedance/seedance-2.5', 'bytedance/seedance-2.0-mini'];

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
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  const models = useToolModels('video', modelsOverride);
  const segOptions = ['Auto', ...segModels(models, SEG_IDS).map((m) => m.name)];
  const feed = useToolFeed('remix');
  const [p, setP] = useState({ model: 'Auto', res: '720p', motion: 6, refw: 80, outfit: 'all', fps: '24', count: '1', seed: '', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const [people, setPeople] = useState(2);
  const [text, setText] = useState(remixPrompt);
  const toast = useToast();
  const [presets, setPresets] = useState<Record<string, string>>(() => Object.fromEntries(remixPresets.map((x) => [x.id, x.value])));
  const [uploads, setUploads] = useState<Record<number, string>>({});
  /** Real mode: upload ids of the character slots, uploaded preset pictures and the reference video. */
  const [slotIds, setSlotIds] = useState<Record<number, string>>({});
  const [presetIds, setPresetIds] = useState<Record<string, string>>({});
  const [video, setVideo] = useState<{ id: string; name: string } | null>(null);
  /** Real mode: the shot fields the user writes (camera, line, actions), keyed by field id. */
  const [shot, setShot] = useState<Record<string, string>>({});
  const real = !isMockApi();
  const videoPicker = useFilePicker('video/*', (file, uploadId) => {
    setVideo({ id: uploadId, name: file.name });
    toast.show({ message: t('tools.remix.video.added', { file: file.name }) });
  });
  const [target, setTarget] = useState<{ kind: 'slot'; i: number } | { kind: 'preset'; id: string } | null>(null);
  const picker = useFilePicker('image/*,video/*', (file, uploadId) => {
    if (!target) return;
    if (target.kind === 'slot') {
      if (file.type.startsWith('image/')) setSlotIds((u) => ({ ...u, [target.i]: uploadId }));
      setUploads((u) => ({ ...u, [target.i]: file.name }));
      toast.show({ message: t('tools.toast.slotUploaded', { name: charName(target.i), file: file.name }) });
    } else {
      setPresets((cur) => ({ ...cur, [target.id]: file.name }));
      if (file.type.startsWith('image/')) setPresetIds((cur) => ({ ...cur, [target.id]: uploadId }));
      toast.show({ message: t('tools.toast.presetUploaded', { file: file.name }) });
    }
  });

  const charName = (i: number) => t('tools.remix.character', { n: i + 1 });
  const slots = Array.from({ length: people }, (_, i) => ({
    name: charName(i),
    tone: i < 2 ? remixSlotTones[i]! : 'var(--c-surface-3)',
    placeholder: i < 2 ? '' : t('tools.remix.slot.placeholder'),
    // Real mode shows only what was uploaded; the mock shows the design's sample cast.
    state: uploads[i] ?? (real ? t('tools.remix.slot.notSet') : i === 0 ? t('tools.remix.slot.template') : i === 1 ? t('tools.remix.slot.uploaded') : t('tools.remix.slot.notSet')),
    set: uploads[i] !== undefined || (!real && i < 2),
  }));
  const fields: Array<[string, string]> = [
    [t('tools.remix.parsed.camera'), remixParsed.camera],
    [t('tools.remix.parsed.line', { n: 1 }), remixParsed.line1],
    [t('tools.remix.parsed.action', { n: 1 }), remixParsed.action1],
    [t('tools.remix.parsed.action', { n: 2 }), remixParsed.action2],
  ];
  for (let i = 2; i < people; i++) fields.push([t('tools.remix.parsed.actionExtra', { n: i + 1 }), t('tools.remix.parsed.idle')]);
  /** Real mode: editable shot fields that become the shot's prompt (`shots[0].prompt`). */
  const shotFields: Array<{ id: string; label: string; placeholder: string }> = [
    { id: 'camera', label: t('tools.remix.parsed.camera'), placeholder: t('tools.remix.shot.placeholder.camera') },
    { id: 'line1', label: t('tools.remix.parsed.line', { n: 1 }), placeholder: t('tools.remix.shot.placeholder.line') },
    ...Array.from({ length: people }, (_, i) => ({ id: `action${i + 1}`, label: t('tools.remix.parsed.action', { n: i + 1 }), placeholder: t('tools.remix.shot.placeholder.action') })),
  ];

  const pct = (v: number) => intl.formatNumber(v / 100, { style: 'percent' });
  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    { kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', ['480p', '720p', '1080p']), value: p.res, onChange: (v) => set('res', v) },
    { kind: 'slider', id: 'motion', title: t('tools.adv.motion'), icon: 'motion', min: 1, max: 10, step: 1, value: p.motion, display: t('tools.outOf10', { n: p.motion }), low: t('tools.adv.motion.low'), high: t('tools.adv.motion.high'), onChange: (v) => set('motion', v) },
    { kind: 'slider', id: 'refw', title: t('tools.adv.refWeight'), icon: 'ref', min: 0, max: 100, step: 5, value: p.refw, display: pct(p.refw), low: t('tools.adv.refWeight.low'), high: t('tools.adv.refWeight.high'), onChange: (v) => set('refw', v) },
    {
      kind: 'seg', id: 'outfit', title: t('tools.adv.outfit'), icon: 'shirt',
      options: [{ value: 'all', label: t('tools.adv.outfit.all') }, ...slots.map((s, i) => ({ value: String(i), label: s.name }))],
      value: p.outfit, onChange: (v) => set('outfit', v),
    },
    { kind: 'seg', id: 'fps', title: t('tools.adv.fps'), icon: 'fps', hint: t('tools.adv.fps.hint'), options: ['24', '30'].map((v) => ({ value: v, label: v })), value: p.fps, onChange: (v) => set('fps', v) },
    { kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: ['1', '2', '4'].map((v) => ({ value: v, label: v })), value: p.count, onChange: (v) => set('count', v) },
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.remix.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  // Real runs have no reference-weight, frame-rate or multi-take settings: those controls stay mock-only.
  const shownAdvGroups = real ? advGroups.filter((g) => g.id !== 'refw' && g.id !== 'fps' && g.id !== 'count') : advGroups;

  const pills: ComposerPill[] = [
    { id: 'model', label: adv && p.model !== 'Auto' ? p.model : t('tools.model.auto'), icon: 'cube' },
    { id: 'ratio', label: '16:9', icon: 'wide' },
    { id: 'duration', label: t('tools.seconds', { n: 10 }), icon: 'clock' },
    { id: 'res', label: adv ? p.res : '720p', icon: 'res' },
    { id: 'audio', label: t('tools.pill.audio'), icon: 'wave' },
    ...(adv
      ? ([
          { id: 'motion', label: t('tools.remix.pill.motion', { n: p.motion }), icon: 'motion' },
          ...(real ? [] : [{ id: 'count', label: t('tools.pill.count', { n: p.count }), icon: 'count' }]),
        ] as ComposerPill[])
      : []),
  ];
  const cost =
    quoteCredits(models, adv ? p.model : 'Auto', { resolution: adv ? p.res : '720p', seconds: 10, count: adv ? Number(p.count) : 1 }) ??
    Math.round((adv ? RES_COST[p.res]! : 10) * 1.2 * (1 + (people - 1) * 0.15) * (adv ? Number(p.count) : 1));
  const go = t('tools.go.video');

  const aside = (
    <>
      <AsideCard title={t('tools.remix.presets')} testId="presets">
        {picker.input}
        {real && (
          <>
            {videoPicker.input}
            <button type="button" className={controls.pickRow} data-remix-video="" onClick={videoPicker.open}>
              <span className={controls.pickThumb} style={{ background: 'var(--c-tone-slate)' }}>
                <ToolIcon name="play" size={16} color="var(--c-text-2)" />
              </span>
              <span className={controls.pickText}>
                <span className={controls.pickLabel}>{t('tools.remix.video')}</span>
                <span className={controls.pickValue}>{video?.name ?? t('tools.remix.video.empty')}</span>
              </span>
              <span className={controls.chev}>›</span>
            </button>
          </>
        )}
        {remixPresets.map((x) => (
          <PickPopover
            key={x.id}
            label={t(`tools.remix.preset.${x.id}`)}
            value={presets[x.id]!}
            options={remixPresetOptions[x.id].map((v) => ({ value: v, label: v }))}
            onChange={(v) => {
              setPresets((cur) => ({ ...cur, [x.id]: v }));
              toast.show({ message: t('tools.toast.presetSet', { name: t(`tools.remix.preset.${x.id}`), value: v }) });
            }}
            extra={x.id === 'action' ? undefined : { label: t('tools.remix.preset.upload'), onSelect: () => (setTarget({ kind: 'preset', id: x.id }), picker.open()) }}
            trigger={(tp) => (
              <button {...tp} type="button" className={controls.pickRow} style={{ flex: 1 }} data-preset={x.id}>
                <span className={controls.pickThumb} style={{ background: x.tone }}>
                  <ToolIcon name={x.icon} size={18} color="var(--c-text-2)" />
                </span>
                <span className={controls.pickText}>
                  <span className={controls.pickLabel}>{t(`tools.remix.preset.${x.id}`)}</span>
                  <span className={controls.pickValue}>{presets[x.id]}</span>
                </span>
                <span className={controls.chev}>›</span>
              </button>
            )}
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
          {slots.map((s, i) => (
            <button
              key={s.name}
              type="button"
              className={styles.slot}
              aria-label={t('tools.remix.slot.upload.label', { name: s.name })}
              data-slot={i}
              onClick={() => {
                setTarget({ kind: 'slot', i });
                picker.open();
              }}
            >
              <span className={styles.slotThumb} style={{ background: s.tone }}>
                {s.placeholder}
              </span>
              <span className={styles.slotName}>@{s.name}</span>
              <span className={styles.slotState} style={{ color: s.set ? 'var(--c-success)' : 'var(--c-text-3)' }}>
                {s.state}
              </span>
            </button>
          ))}
        </div>
      </AsideCard>
      {real ? (
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
      ) : (
        <AsideCard title={t('tools.remix.parsed')} hint={t('tools.remix.parsed.hint')} testId="parsed">
          {fields.map(([k, v]) => (
            <div key={k} className={styles.field}>
              <span className={styles.fieldK}>{k}</span>
              <span className={styles.fieldV}>{v}</span>
            </div>
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
      advGroups={shownAdvGroups}
      composer={{
        noteLead: t('tools.remix.note'),
        noteChips: [t('tools.remix.note.camera', { n: 1 }), t('tools.remix.note.lines', { n: 1 }), t('tools.remix.note.actions', { n: people })],
        refs: slots.slice(0, 2).map((s, i) => ({ badge: `@${i + 1}`, tone: s.tone })),
        label: t('tools.remix.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.remix.composer.placeholder'),
        pills,
        cost,
        goLabel: go,
      }}
      models={models}
      pickerKind="video"
      paramKind="video"
      model={p.model}
      onModel={(m) => set('model', m)}
      confirm={{ cost, label: go }}
      run={{
        aspect: '16/9',
        video: true,
        tags: ['16:9', t('tools.seconds', { n: 10 }), adv ? p.res : '720p', t('tools.remix.people', { n: people })],
        tiles: [],
        steps: [t('tools.run.step.tidy'), adv && p.model !== 'Auto' ? p.model : t('tools.model.auto')],
        generating: (n) => t('tools.run.step.generating', { pct: n / 100 }),
        durationSec: 10,
      }}
      actions={['redo', 'sliders', 'frame', 'down', 'star']}
      spec={(prompt) => {
        if (!video) return t('tools.remix.needVideo');
        // New looks: the character slots and any uploaded outfit/scene picture (docs/api.md → Runs, remix).
        const referenceAssetIds = [...Object.entries(slotIds).filter(([i]) => Number(i) < people).map(([, id]) => id), ...Object.values(presetIds)].slice(0, 8);
        const shotLine = shotPrompt(shotFields.map((f) => [f.label, shot[f.id] ?? '']));
        const hints = adv ? remixHints({ motion: p.motion, outfitFor: p.outfit === 'all' ? null : charName(Number(p.outfit)) }) : [];
        return {
          kind: 'remix',
          model: adv && p.model !== 'Auto' ? (models.find((m) => m.name === p.model)?.id ?? p.model) : 'auto',
          prompt: [prompt.trim(), ...remixPresets.map((x) => `${t(`tools.remix.preset.${x.id}`)}: ${presets[x.id]}`), ...hints].filter(Boolean).join('\n'),
          ...(shotLine ? { shots: [{ prompt: shotLine }] } : {}),
          title: t('tools.remix.title'),
          ratio: '16:9',
          seconds: 10,
          resolution: adv ? p.res : '720p',
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
