import { useToast } from '@rolling/ui';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import controls from '../shared/controls.module.css';
import { ToolIcon } from '../shared/icons';
import layout from '../shared/ToolLayout.module.css';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import { useFilePicker } from '../shared/useFilePicker';
import { useCreationMode } from '@/lib/prefs';
import { quoteCredits, segModels, useToolModels } from '../shared/useToolModels';
import type { PlanId } from '@rolling/core/pricing/config';
import type { ToolModel } from '../shared/models';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import type { ComposerPill } from '../types';
import styles from './Character.module.css';
import { characterBody, characterHair, characterOutfits, characterPrompt, characterStyles, characterStyleTones } from './mocks';

const RES_COST: Record<string, number> = { '1K': 2, '2K': 4, '4K': 8 };
/** Image models; "Seedream 5.0 Pro" runs on `bytedance/seedream-5.5` until Pro is listed (D-002). */
/** Short list for the Advanced "Model" control (design order), by catalog id. */
const SEG_IDS = ['bytedance/seedream-5.5', 'qwen/qwen-image-2.0'];

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); defaults to the session's plan (lib/session). */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the session. */
  isMember?: boolean;
}

export function CharacterPage({ initialOverlay, models: modelsOverride, plan: planProp, isMember }: Props) {
  const plan = useToolPlan(planProp);
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  const models = useToolModels('image', modelsOverride);
  const segOptions = ['Auto', ...segModels(models, SEG_IDS).map((m) => m.name)];
  const feed = useToolFeed('character');
  const [p, setP] = useState({ model: 'Auto', idw: 85, facew: 70, wearw: 60, res: '2K', hairCustom: '', bodyCustom: '', seed: '', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const [age, setAge] = useState('28');
  const [height, setHeight] = useState('168');
  const [pick, setPick] = useState({ hair: 'sideBob', body: 'balanced', wear: 'cityCasual', style: 'photoreal' });
  const [text, setText] = useState(characterPrompt);

  const pct = (v: number) => intl.formatNumber(v / 100, { style: 'percent' });
  const styleLabel = t(`tools.character.style.${pick.style}`);
  const summary = [
    age && t('tools.character.age.value', { n: age }),
    height && t('tools.character.height.value', { n: height }),
    t(`tools.character.hair.${pick.hair}`),
    t(`tools.character.body.${pick.body}`),
    t(`tools.character.wear.${pick.wear}`),
    styleLabel,
  ].filter(Boolean) as string[];

  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    { kind: 'slider', id: 'idw', title: t('tools.character.adv.identity'), icon: 'person', min: 50, max: 100, step: 5, value: p.idw, display: pct(p.idw), low: t('tools.character.adv.identity.low'), high: t('tools.character.adv.identity.high'), onChange: (v) => set('idw', v) },
    { kind: 'slider', id: 'facew', title: t('tools.character.adv.face'), icon: 'ref', min: 0, max: 100, step: 5, value: p.facew, display: pct(p.facew), low: t('tools.adv.low'), high: t('tools.adv.high'), onChange: (v) => set('facew', v) },
    { kind: 'slider', id: 'wearw', title: t('tools.character.adv.outfit'), icon: 'shirt', min: 0, max: 100, step: 5, value: p.wearw, display: pct(p.wearw), low: t('tools.adv.low'), high: t('tools.adv.high'), onChange: (v) => set('wearw', v) },
    { kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'image', ['1K', '2K', '4K']), value: p.res, onChange: (v) => set('res', v) },
    { kind: 'input', id: 'hairCustom', title: t('tools.character.adv.hair'), icon: 'person', value: p.hairCustom, placeholder: t('tools.character.adv.hair.placeholder'), onChange: (v) => set('hairCustom', v) },
    { kind: 'text', id: 'bodyCustom', title: t('tools.character.adv.body'), icon: 'body', value: p.bodyCustom, placeholder: t('tools.character.adv.body.placeholder'), onChange: (v) => set('bodyCustom', v) },
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.character.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  const views = t('tools.character.pill.views');
  const pills: ComposerPill[] = adv
    ? [
        { id: 'model', label: p.model === 'Auto' ? t('tools.model.auto') : p.model, icon: 'cube' },
        { id: 'style', label: styleLabel, icon: 'style' },
        { id: 'views', label: views, icon: 'ratio' },
        { id: 'res', label: p.res, icon: 'res' },
        { id: 'consistency', label: t('tools.character.pill.consistency', { pct: p.idw / 100 }), icon: 'person' },
      ]
    : [
        { id: 'model', label: t('tools.model.auto'), icon: 'cube' },
        { id: 'style', label: styleLabel, icon: 'style' },
        { id: 'views', label: views, icon: 'ratio' },
      ];
  // Two views per run.
  const cost = quoteCredits(models, adv ? p.model : 'Auto', { resolution: adv ? p.res : '2K', count: 2 }) ?? (adv ? RES_COST[p.res]! : 4);
  const go = t('tools.character.go');

  const toast = useToast();
  const [refs, setRefs] = useState<Record<'face' | 'outfit', string | null>>({ face: null, outfit: null });
  /** Real mode: the reference pictures' upload ids (resolved to asset ids before the quote). */
  const [refIds, setRefIds] = useState<Record<'face' | 'outfit', string | null>>({ face: null, outfit: null });
  const [refTarget, setRefTarget] = useState<'face' | 'outfit'>('face');
  const refPicker = useFilePicker('image/*', (file, uploadId) => {
    setRefs((r) => ({ ...r, [refTarget]: file.name }));
    setRefIds((r) => ({ ...r, [refTarget]: uploadId }));
    toast.show({ message: t('tools.toast.refAdded', { name: file.name }) });
  });

  const chipGroup = (key: 'hair' | 'body' | 'wear', list: string[]) => (
    <AsideCard testId={key}>
      <h2 className={layout.cardTitle}>{t(`tools.character.${key}`)}</h2>
      <div className={controls.chips}>
        {list.map((v) => (
          <button key={v} type="button" className={controls.chip} aria-pressed={pick[key] === v} onClick={() => setPick((c) => ({ ...c, [key]: v }))}>
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
          {refPicker.input}
          {(['face', 'outfit'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={styles.refBtn}
              data-ref-slot={k}
              aria-label={refs[k] ? t('tools.character.reference.replace', { file: refs[k]! }) : undefined}
              onClick={() => {
                setRefTarget(k);
                refPicker.open();
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
      composer={{
        noteLead: t('tools.character.note'),
        noteChips: [t('tools.character.note.full'), t('tools.character.note.face'), ...summary.slice(0, 3)],
        refs: [],
        label: t('tools.character.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.character.composer.placeholder'),
        pills,
        cost,
        goLabel: go,
      }}
      models={models}
      pickerKind="image"
      paramKind="image"
      model={p.model}
      onModel={(m) => set('model', m)}
      confirm={{ cost, label: go }}
      run={{
        aspect: '2/3',
        video: false,
        tags: summary.slice(0, 5),
        tiles: [t('tools.character.tile.full'), t('tools.character.tile.face')],
        steps: [t('tools.run.step.describe'), p.model === 'Auto' || !adv ? t('tools.model.auto') : p.model],
        generating: (n) => t('tools.run.step.generating', { pct: n / 100 }),
      }}
      actions={['redo', 'sliders', 'save', 'down', 'star']}
      spec={(prompt) => {
        // Full body, then the face from it; saved to Characters when it finishes (docs/api.md → Runs).
        const traits = [
          ...summary,
          adv && p.hairCustom.trim() ? p.hairCustom.trim() : '',
          adv && p.bodyCustom.trim() ? p.bodyCustom.trim() : '',
        ].filter(Boolean);
        const referenceAssetIds = [refIds.face, refIds.outfit].filter((x): x is string => !!x);
        return {
          kind: 'character',
          name: summary.slice(0, 3).join(', ') || t('tools.character.title'),
          model: adv && p.model !== 'Auto' ? (models.find((m) => m.name === p.model)?.id ?? p.model) : 'auto',
          prompt: [prompt.trim(), traits.join(', ')].filter(Boolean).join('. '),
          title: t('tools.character.title'),
          resolution: adv ? p.res : '2K',
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
