import { Link, useNavigate } from '@tanstack/react-router';
import { useToast } from '@rolling/ui';
import type { PlanId } from '@rolling/core/pricing/config';
import { useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { isMockApi, mockData } from '@/lib/api/mode';
import { useCreationMode } from '@/lib/prefs';
import { createProjectFromTemplate, useTemplate, useTemplates, type SlotFills } from '@/features/templates/api';
import { coverStyle } from '@/features/templates/cover';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import { formatClock } from '../shared/format';
import { ToolIcon } from '../shared/icons';
import type { ToolModel } from '../shared/models';
import { settingsPills, settingsTags } from '../shared/pills';
import { resolutionOptions, useToolPlan } from '../shared/plan';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { useToolSettings, type ToolSettings } from '../shared/settings';
import { ToolSwitch } from '../shared/Switch';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import layout from '../shared/ToolLayout.module.css';
import { usePickAsset } from '../shared/usePickAsset';
import { modelIdOf, segModels, TOOL_NEEDS, useToolModels } from '../shared/useToolModels';
import type { ComposerPill } from '../types';
import styles from './QuickCreate.module.css';

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); defaults to the session's plan (lib/session). */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the session. */
  isMember?: boolean;
  /** `?template=<id>` from Templates (“Use template”). */
  templateId?: string;
  /** `?ratio=<w:h>` chosen with the template. */
  ratio?: string;
}

interface Slot {
  id: string;
  name: string;
  uploaded: boolean;
  shots?: string;
  tone: string;
  file?: string;
  /** The picked image asset (a template default, or one chosen in the asset picker). */
  assetId?: string;
}

export function QuickCreatePage({ initialOverlay, models: modelsOverride, plan: planProp, isMember, templateId, ratio: ratioParam }: Props) {
  // Mock mode: the design's sample template, cast, lines and shots, only through the mock adapter.
  const demo = isMockApi() ? mockData().quick : null;
  const { data: templates } = useTemplates();
  // Real mode: `GET /api/templates/:id` (slots and graph); the list row gives the name, length and ratio meanwhile.
  const detail = useTemplate(demo ? undefined : templateId).data;
  const picked = templateId ? (detail ?? [...templates.featured, ...templates.items].find((x) => x.id === templateId)) : undefined;
  const urlRatio = ratioParam && /^\d{1,2}:\d{1,2}$/.test(ratioParam) ? ratioParam : undefined;
  // The template's own ratio; the cover's pixel size is not a ratio (it gave "720:614").
  const templateRatio = picked ? (picked.ratio ?? undefined) : demo?.quickTemplate.aspect;
  const ratio = urlRatio ?? templateRatio;
  const template = picked
    ? { name: picked.name, durationSec: picked.durationSec, tone: 'var(--c-tone-indigo)', shots: demo?.quickTemplate.shots, style: demo?.quickTemplate.style }
    : demo
      ? { ...demo.quickTemplate }
      : null;
  const plan = useToolPlan(planProp);
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  const models = useToolModels('video', modelsOverride, TOOL_NEEDS.quick);
  const segOptions = ['Auto', ...segModels(models, demo?.quickSegIds).map((m) => m.name)];
  const feed = useToolFeed('quick');
  const [p, setP] = useState({ model: 'Auto', fit: 'repace', fps: '24', speed: 1, seed: demo?.quickSeed ?? '', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const model = adv ? p.model : 'Auto';
  // The template's ratio and length are the starting point; the model's caps fit them.
  const seed = useMemo<Partial<ToolSettings>>(
    () => ({ ...(demo?.quickSettings ?? {}), ...(ratio ? { ratio } : {}), ...(template?.durationSec ? { seconds: template.durationSec } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ratio, template?.durationSec, !!demo],
  );
  const settings = useToolSettings(models, model, 'video', seed);
  const s = settings.value;
  const caps = settings.caps;
  const [lines, setLines] = useState(() => demo?.quickLines.map((l) => l.text) ?? []);
  const [text, setText] = useState(demo?.quickPrompt ?? '');
  const toast = useToast();
  const [slots, setSlots] = useState<Slot[]>(() => demo?.quickSlots.map((x) => ({ ...x, id: x.name })) ?? []);
  // Real mode with a template: its picture slots are the cast to swap.
  const templateSlots = demo ? undefined : picked?.slots?.filter((x) => x.kind === 'image');
  useEffect(() => {
    if (!templateSlots) return;
    setSlots(templateSlots.map((x, i) => ({ name: x.label, uploaded: !!x.default, tone: i % 2 ? 'var(--c-tone-neutral)' : 'var(--c-tone-plum)', id: x.id, assetId: x.default })));
    // Once per template.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.id, templateSlots?.length]);
  const textSlot = demo ? undefined : picked?.slots?.find((x) => x.kind === 'text' && x.default);
  useEffect(() => {
    if (textSlot?.default) setText(textSlot.default);
    // Once per template.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.id]);
  const [opening, setOpening] = useState(false);
  const navigate = useNavigate();
  /** Real mode: `POST /api/projects { fromTemplateId, slots }` with the swapped pictures, then the canvas (nothing is spent). */
  const openOnCanvas = async () => {
    if (!templateId) return;
    setOpening(true);
    try {
      const fills: SlotFills = {};
      for (const x of slots) if (x.assetId && picked?.slots?.some((ps) => ps.id === x.id)) fills[x.id] = { assetId: x.assetId };
      const project = await createProjectFromTemplate(templateId, fills);
      void navigate({ to: '/p/$projectId', params: { projectId: project.id } });
    } catch {
      toast.show({ message: t('tools.quick.openFailed') });
    } finally {
      setOpening(false);
    }
  };
  const [slotTarget, setSlotTarget] = useState<string | null>(null);
  const [lineLang, setLineLang] = useState('en-US');
  /** A slot takes an image asset: from My assets, a Character, the public library (portraits first) or an upload into Assets. */
  const slotPicker = usePickAsset({ kinds: ['image', 'character'], categories: ['portrait'], tab: 'mine' }, (pick) => {
    if (!slotTarget) return;
    setSlots((all) => all.map((x) => (x.name === slotTarget ? { ...x, uploaded: true, shots: x.shots, file: pick.name, assetId: pick.assetId } : x)));
    toast.show({ message: t('tools.toast.slotUploaded', { name: slotTarget, file: pick.name }) });
  });

  const modelLabel = (m: string) => (m === 'Auto' ? t('tools.model.auto') : m);
  const span = (a: number, b: number) => t('tools.span', { from: formatClock(intl, a), to: formatClock(intl, b) });

  // Only settings with a run parameter behind them; the design's extra controls exist for the sample model alone.
  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    ...(demo && caps.design
      ? ([
          {
            kind: 'shots', id: 'shots', title: t('tools.adv.shots'), icon: 'shots', hint: t('tools.adv.shots.hint', { n: demo.quickShots.length }),
            shots: demo.quickShots.map((x) => ({
              id: x.id,
              time: t('tools.adv.shots.range', { from: x.from, to: x.to }),
              desc: x.desc,
              fields: x.fields.map(([f, state]) => ({ label: t(`tools.adv.field.${f}`), state })),
            })),
          },
          { kind: 'seg', id: 'fit', title: t('tools.adv.fit'), icon: 'clock', options: [{ value: 'repace', label: t('tools.adv.fit.repace') }, { value: 'keep', label: t('tools.adv.fit.keep') }], value: p.fit, onChange: (v) => set('fit', v) },
        ] satisfies SettingsGroupDef[])
      : []),
    ...(caps.resolutions.length
      ? [{ kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', caps.resolutions), value: s.resolution, onChange: (v: string) => settings.set({ ...s, resolution: v }) } satisfies SettingsGroupDef]
      : []),
    ...(caps.design
      ? ([
          { kind: 'seg', id: 'fps', title: t('tools.adv.fps'), icon: 'fps', hint: t('tools.adv.fps.hint'), options: ['24', '30'].map((v) => ({ value: v, label: v })), value: p.fps, onChange: (v) => set('fps', v) },
          {
            kind: 'slider', id: 'speed', title: t('tools.adv.speechRate'), icon: 'wave', min: 0.8, max: 1.2, step: 0.05, value: p.speed,
            display: t('tools.rate', { v: intl.formatNumber(p.speed, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
            low: t('tools.adv.slow'), high: t('tools.adv.fast'), onChange: (v) => set('speed', v),
          },
        ] satisfies SettingsGroupDef[])
      : []),
    ...(caps.counts.length > 1
      ? [{ kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: caps.counts.map((v) => ({ value: String(v), label: String(v) })), value: String(s.count), onChange: (v: string) => settings.set({ ...s, count: Number(v) }) } satisfies SettingsGroupDef]
      : []),
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.quick.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  // The template's own ratio reads "9:16 Original"; another ratio shows as itself.
  const ratioLabel = (r: string) => (templateRatio && !urlRatio && r === templateRatio ? t('tools.quick.pill.ratioOriginal', { ratio: r }) : r);
  const pills: ComposerPill[] = [
    { id: 'model', label: modelLabel(model), icon: 'cube' },
    ...settingsPills(intl, s, caps, { ratioLabel, audio: false }),
    ...(adv
      ? ([
          ...(caps.design ? [{ id: 'fps', label: t('tools.pill.fps', { n: p.fps }), icon: 'fps' }] : []),
          ...(caps.counts.length > 1 ? [{ id: 'count', label: t('tools.pill.count', { n: s.count }), icon: 'count' }] : []),
          { id: 'seed', label: p.seed ? t('tools.pill.seed', { seed: p.seed }) : t('tools.pill.seedRandom'), icon: 'seed' },
        ] as ComposerPill[])
      : []),
  ];
  const go = t('tools.go.video');
  const title = template ? t('tools.quick.title', { template: template.name }) : t('tools.quick.titleNone');

  const aside = (
    <>
      <AsideCard row gap={12} testId="template">
        <div className={styles.tplThumb} style={coverStyle(picked?.coverUrl, template?.tone ?? 'var(--c-surface-3)')} data-cover={picked?.coverUrl ? '' : undefined}>
          {picked?.coverUrl ? null : <ToolIcon name="play" size={14} filled color="var(--c-text-1)" />}
        </div>
        <div className={styles.tplText}>
          <span className={styles.tplKicker}>
            <FormattedMessage id="tools.quick.templates" />
          </span>
          {/* Design layout (chip on the right): long names wrap by word and clamp with an ellipsis; the full name is the tooltip. */}
          <span className={styles.tplName} title={template?.name}>
            {template?.name ?? t('tools.quick.noTemplate')}
          </span>
          <span className={styles.tplMeta}>
            {template ? (
              // Only real parts: the template's own ratio (never the cover's pixel size), no "0s".
              [
                ratio,
                template.durationSec > 0 ? t('tools.seconds', { n: template.durationSec }) : null,
                template.shots !== undefined ? t('tools.quick.shotCount', { n: Number(template.shots) }) : null,
                template.style ?? null,
              ]
                .filter((x): x is string => !!x)
                .join(' · ')
            ) : (
              <FormattedMessage id="tools.quick.noTemplate.hint" />
            )}
          </span>
        </div>
        <div className={styles.tplActions}>
          <Link to="/templates" className={layout.chipBtn}>
            <FormattedMessage id={template ? 'tools.quick.changeTemplate' : 'tools.quick.pickTemplate'} />
          </Link>
          {!demo && templateId ? (
            <button type="button" className={layout.chipBtn} data-open-canvas="" disabled={opening} onClick={() => void openOnCanvas()}>
              <FormattedMessage id="tools.quick.openOnCanvas" />
            </button>
          ) : null}
        </div>
      </AsideCard>
      {slots.length > 0 && (
        <AsideCard title={t('tools.quick.swap')} hint={t('tools.quick.swap.hint')} testId="swap">
          {slotPicker.element}
          {slots.map((x) => (
            <div key={x.name} className={styles.slot} data-slot={x.name}>
              <div className={styles.slotThumb} style={{ background: x.tone }}>
                {!x.uploaded && <ToolIcon name="upload" size={16} />}
              </div>
              <div className={styles.slotText}>
                <span className={styles.slotName}>@{x.name}</span>
                <span className={styles.slotState} style={{ color: x.uploaded ? 'var(--c-success)' : 'var(--c-text-3)' }}>
                  {x.file ? x.file : x.uploaded && x.shots ? t('tools.quick.slot.uploaded', { shots: x.shots }) : x.uploaded ? t('tools.remix.slot.uploaded') : t('tools.quick.slot.empty')}
                </span>
              </div>
              <button
                type="button"
                className={layout.chipBtn}
                aria-label={t(x.uploaded ? 'tools.quick.slot.replace.label' : 'tools.quick.slot.upload.label', { name: x.name })}
                onClick={() => {
                  setSlotTarget(x.name);
                  slotPicker.open({ title: `@${x.name}` });
                }}
              >
                <FormattedMessage id={x.uploaded ? 'tools.quick.slot.replace' : 'tools.quick.slot.upload'} />
              </button>
            </div>
          ))}
        </AsideCard>
      )}
      {demo && (
        <AsideCard
          title={t('tools.quick.lines')}
          testId="lines"
          end={
            <select
              aria-label={t('tools.quick.lines.language')}
              className={layout.select}
              value={lineLang}
              onChange={(e) => {
                setLineLang(e.target.value);
                toast.show({ message: t('tools.toast.linesLanguage', { language: e.target.selectedOptions[0]?.text ?? e.target.value }) });
              }}
            >
              <option value="en-US">English (US)</option>
              <option value="zh">Chinese (Mandarin)</option>
              <option value="ja">Japanese</option>
            </select>
          }
        >
          {demo.quickLines.map((l, i) => (
            <div key={l.id} className={styles.line}>
              <span className={styles.lineHead}>
                <b>{l.who}</b>
                <span>{span(l.from, l.to)}</span>
              </span>
              <label htmlFor={`quick-${l.id}`} className="rl-visually-hidden">
                <FormattedMessage id="tools.quick.lineLabel" values={{ who: l.who }} />
              </label>
              <input id={`quick-${l.id}`} className={styles.lineInput} value={lines[i]} onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
            </div>
          ))}
        </AsideCard>
      )}
      {caps.audio && (
        // Ambience is the model's generated audio (`audio` on the run).
        <AsideCard row testId="ambience">
          <span className={styles.ambience}>
            <FormattedMessage id="tools.quick.ambience" />
          </span>
          <ToolSwitch on={s.audio} label={t('tools.quick.ambience')} onToggle={() => settings.set({ ...s, audio: !s.audio })} />
        </AsideCard>
      )}
    </>
  );

  return (
    <ToolLayout
      testId="tool-quick"
      title={title}
      count={(f) => t('tools.results', { n: f.length })}
      feedMin={210}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      settings={{ value: s, caps, onChange: settings.set, onReset: settings.reset }}
      composer={{
        noteLead: t('tools.quick.note'),
        noteChips: demo ? [t(adv ? demo.quickNoteChips.advanced : demo.quickNoteChips.simple)] : [],
        refs: slots.flatMap((x) => (x.uploaded ? [{ badge: `@${x.name}`, tone: x.tone }] : [])),
        label: t('tools.quick.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.quick.composer.placeholder'),
        pills,
        goLabel: go,
      }}
      models={models}
      pickerKind="video"
      paramKind="video"
      model={model}
      onModel={(m) => set('model', m)}
      confirm={{ cost: demo ? demo.quickMockCost({ adv, res: s.resolution, count: s.count }) : 0, label: go }}
      run={{
        aspect: s.ratio && s.ratio !== 'Auto' ? s.ratio.replace(':', '/') : '9/16',
        video: true,
        tags: settingsTags(intl, s),
        tiles: [],
        steps: [t('tools.run.step.prepare'), modelLabel(model)],
        generating: (pct) => t('tools.run.step.generating', { pct: pct / 100 }),
        durationSec: s.seconds || undefined,
      }}
      actions={['redo', 'sliders', 'frame', 'down', 'star']}
      spec={(prompt) => {
        // The swapped cast pictures go in as references (resolved from upload ids before the quote).
        const referenceAssetIds = slots.flatMap((x) => (x.assetId ? [x.assetId] : []));
        return {
          kind: 'video',
          model: modelIdOf(models, model),
          prompt,
          ...(template ? { title: template.name } : {}),
          ...(s.ratio && s.ratio !== 'Auto' ? { ratio: s.ratio } : {}),
          ...(s.seconds ? { seconds: s.seconds } : {}),
          ...(s.resolution ? { resolution: s.resolution } : {}),
          ...(caps.audio ? { audio: s.audio } : {}),
          ...(adv && /^\d+$/.test(p.seed) ? { seed: Number(p.seed) } : {}),
          ...(adv && p.neg.trim() ? { negativePrompt: p.neg.trim() } : {}),
          ...(referenceAssetIds.length ? { refsMode: true, inputs: { referenceAssetIds } } : {}),
        };
      }}
      agentTool="quick"
      onFields={(f) => {
        const m = typeof f.model === 'string' ? models.find((x) => x.id === f.model || x.name === f.model) : undefined;
        if (m) set('model', m.name);
        const patch: Partial<ToolSettings> = {};
        if (typeof f.ratio === 'string') patch.ratio = f.ratio;
        if (typeof f.seconds === 'number') patch.seconds = f.seconds;
        if (typeof f.resolution === 'string') patch.resolution = f.resolution;
        if (Object.keys(patch).length) settings.set({ ...s, ...patch });
      }}
      viewerAspect="9/16"
      initialOverlay={initialOverlay}
      isMember={isMember}
      plan={plan}
    />
  );
}
