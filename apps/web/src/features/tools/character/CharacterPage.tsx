import { useToast } from '@rolling/ui';
import type { PlanId } from '@rolling/core/pricing/config';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { isMockApi, mockData } from '@/lib/api/mode';
import { useCreationMode } from '@/lib/prefs';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import controls from '../shared/controls.module.css';
import { ToolIcon } from '../shared/icons';
import type { ToolModel } from '../shared/models';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { useToolSettings, type ToolCaps } from '../shared/settings';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import layout from '../shared/ToolLayout.module.css';
import { toPick, type LibraryPick } from '../shared/LibraryPicker';
import { usePickAsset } from '../shared/usePickAsset';
import { modelIdOf, segModels, TOOL_NEEDS, useToolModels } from '../shared/useToolModels';
import type { ComposerPill } from '../types';
import styles from './Character.module.css';
import { characterBody, characterHair, characterOutfits, characterStyles, characterStyleTones } from './options';

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); defaults to the session's plan (lib/session). */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the session. */
  isMember?: boolean;
}

type Pick = { hair: string; body: string | null; wear: string | null; style: string };

export function CharacterPage({ initialOverlay, models: modelsOverride, plan: planProp, isMember }: Props) {
  const plan = useToolPlan(planProp);
  const intl = useIntl();
  const navigate = useNavigate();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  // Mock mode: the design's sample character, only through the mock adapter.
  const demo = isMockApi() ? mockData().character : null;
  const models = useToolModels('image', modelsOverride, TOOL_NEEDS.character);
  const segOptions = ['Auto', ...segModels(models, demo?.characterSegIds).map((m) => m.name)];
  const feed = useToolFeed('character');
  const [p, setP] = useState({ model: 'Auto', idw: 85, facew: 70, wearw: 60, hairCustom: '', bodyCustom: '', seed: '', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const model = adv ? p.model : 'Auto';
  const settings = useToolSettings(models, model, 'image', demo?.characterSettings);
  const s = settings.value;
  // The tool makes one picture per view in its own framing (full body 3:4, face 1:1): no ratio or count to choose.
  const caps: ToolCaps = settings.caps.design ? settings.caps : { ...settings.caps, ratios: [], counts: [] };
  const [age, setAge] = useState(demo?.characterSample.age ?? '');
  const [height, setHeight] = useState(demo?.characterSample.height ?? '');
  const [pick, setPick] = useState<Pick>(() => demo?.characterSample.pick ?? { hair: 'fromDescription', body: null, wear: null, style: 'photoreal' });
  const [text, setText] = useState(demo?.characterPrompt ?? '');
  /** Hair and outfit picked from the public library (or the user's assets) instead of a chip: a reference image plus its prompt text. */
  const [libLook, setLibLook] = useState<Record<'hair' | 'wear', LibraryPick | null>>({ hair: null, wear: null });

  const pct = (v: number) => intl.formatNumber(v / 100, { style: 'percent' });
  const styleLabel = t(`tools.character.style.${pick.style}`);
  const summary = [
    age && t('tools.character.age.value', { n: age }),
    height && t('tools.character.height.value', { n: height }),
    libLook.hair ? libLook.hair.title : pick.hair !== 'fromDescription' || demo ? t(`tools.character.hair.${pick.hair}`) : '',
    pick.body ? t(`tools.character.body.${pick.body}`) : '',
    libLook.wear ? libLook.wear.title : pick.wear ? t(`tools.character.wear.${pick.wear}`) : '',
    styleLabel,
  ].filter(Boolean) as string[];

  // Only settings a real run uses; the reference weights exist for the design's sample model alone.
  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    ...(caps.design
      ? ([
          { kind: 'slider', id: 'idw', title: t('tools.character.adv.identity'), icon: 'person', min: 50, max: 100, step: 5, value: p.idw, display: pct(p.idw), low: t('tools.character.adv.identity.low'), high: t('tools.character.adv.identity.high'), onChange: (v) => set('idw', v) },
          { kind: 'slider', id: 'facew', title: t('tools.character.adv.face'), icon: 'ref', min: 0, max: 100, step: 5, value: p.facew, display: pct(p.facew), low: t('tools.adv.low'), high: t('tools.adv.high'), onChange: (v) => set('facew', v) },
          { kind: 'slider', id: 'wearw', title: t('tools.character.adv.outfit'), icon: 'shirt', min: 0, max: 100, step: 5, value: p.wearw, display: pct(p.wearw), low: t('tools.adv.low'), high: t('tools.adv.high'), onChange: (v) => set('wearw', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    ...(caps.resolutions.length
      ? [{ kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'image', caps.resolutions), value: s.resolution, onChange: (v: string) => settings.set({ ...s, resolution: v }), lockMedia: 'image' } satisfies SettingsGroupDef]
      : []),
    { kind: 'input', id: 'hairCustom', title: t('tools.character.adv.hair'), icon: 'person', value: p.hairCustom, placeholder: t('tools.character.adv.hair.placeholder'), onChange: (v) => set('hairCustom', v) },
    { kind: 'text', id: 'bodyCustom', title: t('tools.character.adv.body'), icon: 'body', value: p.bodyCustom, placeholder: t('tools.character.adv.body.placeholder'), onChange: (v) => set('bodyCustom', v) },
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.character.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  // Real runs make the turnaround sheet: four angles and two expressions (D-032).
  const views = caps.design ? t('tools.character.pill.views') : t('characters.tool.views', { n: 6 });
  const pills: ComposerPill[] = [
    { id: 'model', label: model === 'Auto' ? t('tools.model.auto') : model, icon: 'cube' },
    { id: 'style', label: styleLabel, icon: 'style' },
    { id: 'views', label: views, icon: 'ratio' },
    // The design's Simple mode shows no resolution pill; real mode always shows what the run sends.
    ...((adv || !caps.design) && caps.resolutions.length && s.resolution ? [{ id: 'res', label: s.resolution, icon: 'res' } as ComposerPill] : []),
    ...(adv && caps.design ? [{ id: 'consistency', label: t('tools.character.pill.consistency', { pct: p.idw / 100 }), icon: 'person' } as ComposerPill] : []),
  ];
  const go = caps.design ? t('tools.character.go') : t('characters.tool.go', { n: 6 });

  const toast = useToast();
  const [refs, setRefs] = useState<Record<'face' | 'outfit', string | null>>({ face: null, outfit: null });
  /** The reference pictures' upload ids (resolved to asset ids before the quote). */
  const [refIds, setRefIds] = useState<Record<'face' | 'outfit', string | null>>({ face: null, outfit: null });
  const [refTarget, setRefTarget] = useState<'face' | 'outfit'>('face');
  const refPicker = usePickAsset({ kinds: ['image', 'character'], categories: ['portrait'], tab: 'mine' }, (pick) => {
    setRefs((r) => ({ ...r, [refTarget]: pick.name }));
    setRefIds((r) => ({ ...r, [refTarget]: pick.assetId }));
    toast.show({ message: t('tools.toast.refAdded', { name: pick.name }) });
  });
  const [lookTarget, setLookTarget] = useState<'hair' | 'wear'>('hair');
  const lookPicker = usePickAsset({ kinds: ['image'], tab: 'public' }, (p0) => {
    const item = toPick(p0);
    setLibLook((c) => ({ ...c, [lookTarget]: item }));
    toast.show({ message: t('tools.toast.presetSet', { name: t(`tools.character.${lookTarget}`), value: item.title }) });
  });
  const LOOK_CATEGORIES = { hair: ['hairstyle'], wear: ['outfit', 'outfit_anime', 'outfit_historical'] } as const;

  const chipGroup = (key: 'hair' | 'body' | 'wear', list: string[]) => (
    <AsideCard testId={key}>
      <div className={styles.lookHead}>
        <h2 className={layout.cardTitle}>{t(`tools.character.${key}`)}</h2>
        {key !== 'body' ? (
          // Hair and outfit can also come from the public library (or the user's assets): the shared asset picker modal.
          <button
            type="button"
            className={styles.libLink}
            aria-pressed={!!libLook[key]}
            aria-haspopup="dialog"
            data-look-library={key}
            onClick={() => {
              setLookTarget(key);
              lookPicker.open({ title: t(`tools.character.${key}`), categories: [...LOOK_CATEGORIES[key]] });
            }}
          >
            {libLook[key]?.title ?? t('tools.character.reference.library')}
          </button>
        ) : null}
      </div>
      <div className={controls.chips}>
        {list.map((v) => (
          <button
            key={v}
            type="button"
            className={controls.chip}
            aria-pressed={pick[key] === v && !(key !== 'body' && libLook[key])}
            // Body and outfit can be left out (the description decides); hair falls back to "From description".
            onClick={() => {
              setPick((c) => ({ ...c, [key]: c[key] === v && key !== 'hair' && !(key === 'wear' && libLook.wear) ? null : v }));
              if (key !== 'body') setLibLook((c) => ({ ...c, [key]: null }));
            }}
          >
            {t(`tools.character.${key}.${v}`)}
          </button>
        ))}
      </div>
    </AsideCard>
  );

  const aside = (
    <>
      <AsideCard title={t('tools.character.reference')} hint={t('tools.character.reference.hint')} testId="reference">
        <div className={styles.refs}>
          {refPicker.element}
          {lookPicker.element}
          {(['face', 'outfit'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={styles.refBtn}
              data-ref-slot={k}
              aria-label={refs[k] ? t('tools.character.reference.replace', { file: refs[k]! }) : undefined}
              onClick={() => {
                setRefTarget(k);
                refPicker.open({ title: t(`tools.character.reference.${k}`), ...(k === 'outfit' ? { categories: ['outfit', 'outfit_anime', 'outfit_historical'] as const } : {}) });
              }}
            >
              <ToolIcon name={refs[k] ? 'check' : k === 'face' ? 'upload' : 'shirt'} size={18} />
              <span>{refs[k] ?? t(`tools.character.reference.${k}`)}</span>
            </button>
          ))}
        </div>
      </AsideCard>
      <AsideCard row gap={8} testId="measures">
        <div className={styles.num}>
          <label htmlFor="character-age" className={styles.numLabel}>
            {t('tools.character.age')}
          </label>
          <div className={styles.numRow}>
            <input id="character-age" inputMode="numeric" className={styles.numInput} value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ''))} />
            <span className={styles.unit}>{t('tools.character.age.unit')}</span>
          </div>
        </div>
        <div className={styles.num}>
          <label htmlFor="character-height" className={styles.numLabel}>
            {t('tools.character.height')}
          </label>
          <div className={styles.numRow}>
            <input id="character-height" inputMode="numeric" className={styles.numInput} value={height} onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))} />
            <span className={styles.unit}>{t('tools.character.height.unit')}</span>
          </div>
        </div>
      </AsideCard>
      {chipGroup('hair', characterHair)}
      {chipGroup('body', characterBody)}
      {chipGroup('wear', characterOutfits)}
      <AsideCard title={t('tools.character.styleTitle')} testId="style">
        <div className={styles.styles}>
          {characterStyles.map((v, i) => (
            <button key={v} type="button" className={styles.style} aria-pressed={pick.style === v} onClick={() => setPick((c) => ({ ...c, style: v }))}>
              <span className={styles.styleSwatch} style={{ background: characterStyleTones[i] }} />
              <span className={styles.styleLabel}>{t(`tools.character.style.${v}`)}</span>
            </button>
          ))}
        </div>
      </AsideCard>
    </>
  );

  return (
    <ToolLayout
      testId="tool-character"
      toolId="character"
      title={t('tools.character.title')}
      count={(f) => t('tools.sets', { n: f.length })}
      feedMin={400}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      settings={{ value: s, caps, onChange: settings.set, onReset: settings.reset }}
      composer={{
        noteLead: t('tools.character.note'),
        noteChips: [t('tools.character.note.full'), t('tools.character.note.face'), ...summary.slice(0, 3)],
        refs: [],
        label: t('tools.character.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.character.composer.placeholder'),
        pills,
        goLabel: go,
      }}
      models={models}
      pickerKind="image"
      paramKind="image"
      model={model}
      onModel={(m) => set('model', m)}
      confirm={{ cost: demo ? demo.characterMockCost({ adv, res: s.resolution }) : 0, label: go }}
      run={{
        aspect: '2/3',
        video: false,
        tags: [...summary.slice(0, 5), ...(s.resolution && !caps.design ? [s.resolution] : [])],
        tiles: [t('tools.character.tile.full'), t('tools.character.tile.face')],
        steps: [t('tools.run.step.describe'), model === 'Auto' ? t('tools.model.auto') : model],
        generating: (n) => t('tools.run.step.generating', { pct: n / 100 }),
      }}
      actions={['redo', 'sliders', 'save', 'down', 'star']}
      spec={(prompt) => {
        // Full body, then the face from it; saved to Characters when it finishes (docs/api.md → Runs).
        const traits = [...summary, adv && p.hairCustom.trim() ? p.hairCustom.trim() : '', adv && p.bodyCustom.trim() ? p.bodyCustom.trim() : ''].filter(Boolean);
        const referenceAssetIds = [refIds.face, refIds.outfit, libLook.hair?.assetId, libLook.wear?.assetId].filter((x): x is string => !!x);
        const looks = [libLook.hair, libLook.wear].flatMap((x) => (x?.promptEn ? [x.promptEn] : []));
        // D-032: one run makes the turnaround sheet (full body, front, 3/4, profile, two expressions) and saves the
        // character with these words as its locked description.
        const hairWords = [libLook.hair?.promptEn ?? (pick.hair !== 'fromDescription' ? t(`tools.character.hair.${pick.hair}`) : ''), adv ? p.hairCustom.trim() : ''].filter(Boolean).join(', ');
        const buildWords = [pick.body ? t(`tools.character.body.${pick.body}`) : '', height ? t('tools.character.height.value', { n: height }) : '', adv ? p.bodyCustom.trim() : ''].filter(Boolean).join(', ');
        const outfitWords = libLook.wear?.promptEn ?? (pick.wear ? t(`tools.character.wear.${pick.wear}`) : '');
        const descriptor = {
          kind: 'person' as const,
          face: [prompt.trim(), age ? t('tools.character.age.value', { n: age }) : ''].filter(Boolean).join(', ').slice(0, 300),
          ...(hairWords && { hair: hairWords.slice(0, 160) }),
          ...(buildWords && { build: buildWords.slice(0, 160) }),
          ...(outfitWords && { outfit: outfitWords.slice(0, 240) }),
          style: styleLabel.slice(0, 200),
        };
        return {
          kind: 'character',
          name: summary.slice(0, 3).join(', ') || t('tools.character.title'),
          model: modelIdOf(models, model),
          sheet: { descriptor },
          prompt: [prompt.trim(), traits.join(', '), ...looks].filter(Boolean).join('. '),
          title: t('tools.character.title'),
          ...(s.resolution ? { resolution: s.resolution } : {}),
          ...(adv && p.neg.trim() ? { negativePrompt: p.neg.trim() } : {}),
          ...(adv && /^\d+$/.test(p.seed) ? { seed: Number(p.seed) } : {}),
          ...(referenceAssetIds.length ? { inputs: { referenceAssetIds } } : {}),
        };
      }}
      viewerAspect="2/3"
      initialOverlay={initialOverlay}
      isMember={isMember}
      plan={plan}
    />
  );
}
