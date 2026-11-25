import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useToolFeed } from '../api';
import { AsideCard } from '../shared/AsideCard';
import { formatClock } from '../shared/format';
import { ToolIcon } from '../shared/icons';
import layout from '../shared/ToolLayout.module.css';
import type { SettingsGroupDef } from '../shared/SettingsGroup';
import { ToolSwitch } from '../shared/Switch';
import { ToolLayout, type ToolOverlay } from '../shared/ToolLayout';
import { useCreationMode } from '../shared/useCreationMode';
import { quoteCredits, segModels, useToolModels } from '../shared/useToolModels';
import type { PlanId } from '@rolling/core/pricing/config';
import type { ToolModel } from '../shared/models';
import { mockPlan, resolutionOptions } from '../shared/plan';
import type { ComposerPill } from '../types';
import { quickLines, quickPrompt, quickShots, quickSlots, quickTemplate } from './mocks';
import styles from './QuickCreate.module.css';

const RES_COST: Record<string, number> = { '480p': 6, '720p': 10, '1080p': 18 };
/** Short list for the Advanced "Model" control (design order), by catalog id. */
const SEG_IDS = ['bytedance/seedance-2.5', 'bytedance/seedance-2.0-mini', 'minimax/minimax-h3'];

interface Props {
  initialOverlay?: ToolOverlay | null;
  /** Injected model list (tests); defaults to the synced catalog. */
  models?: ToolModel[];
  /** Current plan (D-006 resolution caps); mocked as Starter until the account API lands. */
  plan?: PlanId;
  /** Active plan (D-007); defaults to the membership mock. */
  isMember?: boolean;
}

export function QuickCreatePage({ initialOverlay, models: modelsOverride, plan = mockPlan, isMember }: Props) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const adv = useCreationMode() === 'advanced';
  const models = useToolModels('video', modelsOverride);
  const segOptions = ['Auto', ...segModels(models, SEG_IDS).map((m) => m.name)];
  const feed = useToolFeed('quick');
  const [p, setP] = useState({ model: 'Auto', fit: 'repace', res: '720p', fps: '24', speed: 1, count: '1', seed: '48213', neg: '' });
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const [lines, setLines] = useState(quickLines.map((l) => l.text));
  const [ambience, setAmbience] = useState(true);
  const [text, setText] = useState(quickPrompt);

  const modelLabel = (m: string) => (m === 'Auto' ? t('tools.model.auto') : m);
  const span = (a: number, b: number) => t('tools.span', { from: formatClock(intl, a), to: formatClock(intl, b) });

  const advGroups: SettingsGroupDef[] = [
    { kind: 'seg', id: 'model', title: t('tools.adv.model'), icon: 'cube', options: segOptions.map((m) => ({ value: m, label: m === 'Auto' ? t('tools.adv.auto') : m })), value: p.model, onChange: (v) => set('model', v) },
    {
      kind: 'shots', id: 'shots', title: t('tools.adv.shots'), icon: 'shots', hint: t('tools.adv.shots.hint', { n: quickShots.length }),
      shots: quickShots.map((s) => ({
        id: s.id,
        time: t('tools.adv.shots.range', { from: s.from, to: s.to }),
        desc: s.desc,
        fields: s.fields.map(([f, state]) => ({ label: t(`tools.adv.field.${f}`), state })),
      })),
    },
    { kind: 'seg', id: 'fit', title: t('tools.adv.fit'), icon: 'clock', options: [{ value: 'repace', label: t('tools.adv.fit.repace') }, { value: 'keep', label: t('tools.adv.fit.keep') }], value: p.fit, onChange: (v) => set('fit', v) },
    { kind: 'seg', id: 'res', title: t('tools.adv.resolution'), icon: 'res', options: resolutionOptions(intl, plan, 'video', ['480p', '720p', '1080p']), value: p.res, onChange: (v) => set('res', v) },
    { kind: 'seg', id: 'fps', title: t('tools.adv.fps'), icon: 'fps', hint: t('tools.adv.fps.hint'), options: ['24', '30'].map((v) => ({ value: v, label: v })), value: p.fps, onChange: (v) => set('fps', v) },
    {
      kind: 'slider', id: 'speed', title: t('tools.adv.speechRate'), icon: 'wave', min: 0.8, max: 1.2, step: 0.05, value: p.speed,
      display: t('tools.rate', { v: intl.formatNumber(p.speed, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
      low: t('tools.adv.slow'), high: t('tools.adv.fast'), onChange: (v) => set('speed', v),
    },
    { kind: 'seg', id: 'count', title: t('tools.adv.count'), icon: 'count', options: ['1', '2', '4'].map((v) => ({ value: v, label: v })), value: p.count, onChange: (v) => set('count', v) },
    { kind: 'input', id: 'seed', title: t('tools.adv.seed'), icon: 'seed', value: p.seed, placeholder: t('tools.adv.seed.placeholder'), dice: true, mono: true, onChange: (v) => set('seed', v), onRoll: () => set('seed', String(Math.floor(Math.random() * 90000) + 10000)) },
    { kind: 'text', id: 'neg', title: t('tools.adv.neg'), icon: 'neg', value: p.neg, placeholder: t('tools.quick.neg.placeholder'), onChange: (v) => set('neg', v) },
  ];

  const ratioPill = t('tools.quick.pill.ratio');
  const dur = t('tools.seconds', { n: quickTemplate.durationSec });
  const pills: ComposerPill[] = adv
    ? [
        { id: 'model', label: modelLabel(p.model), icon: 'cube' },
        { id: 'ratio', label: ratioPill, icon: 'ratio' },
        { id: 'duration', label: dur, icon: 'clock' },
        { id: 'res', label: p.res, icon: 'res' },
        { id: 'fps', label: t('tools.pill.fps', { n: p.fps }), icon: 'fps' },
        { id: 'count', label: t('tools.pill.count', { n: p.count }), icon: 'count' },
        { id: 'seed', label: p.seed ? t('tools.pill.seed', { seed: p.seed }) : t('tools.pill.seedRandom'), icon: 'seed' },
      ]
    : [
        { id: 'model', label: t('tools.model.auto'), icon: 'cube' },
        { id: 'ratio', label: ratioPill, icon: 'ratio' },
        { id: 'duration', label: dur, icon: 'clock' },
        { id: 'res', label: '720p', icon: 'res' },
      ];
  const cost =
    quoteCredits(models, adv ? p.model : 'Auto', { resolution: adv ? p.res : '720p', seconds: quickTemplate.durationSec, count: adv ? Number(p.count) : 1 }) ??
    (adv ? RES_COST[p.res]! * Number(p.count) : 10);
  const go = t('tools.go.video');

  const aside = (
    <>
      <AsideCard row gap={12} testId="template">
        <div className={styles.tplThumb} style={{ background: quickTemplate.tone }}>
          <ToolIcon name="play" size={14} filled color="#F5F5F5" />
        </div>
        <div className={styles.tplText}>
          <span className={styles.tplKicker}>
            <FormattedMessage id="tools.quick.templates" />
          </span>
          <span className={styles.tplName}>{quickTemplate.name}</span>
          <span className={styles.tplMeta}>
            <FormattedMessage
              id="tools.quick.templateMeta"
              values={{ aspect: quickTemplate.aspect, dur: t('tools.seconds', { n: quickTemplate.durationSec }), shots: quickTemplate.shots, style: quickTemplate.style }}
            />
          </span>
        </div>
        <Link to="/templates" className={layout.chipBtn}>
          <FormattedMessage id="tools.quick.changeTemplate" />
        </Link>
      </AsideCard>
      <AsideCard title={t('tools.quick.swap')} hint={t('tools.quick.swap.hint')} testId="swap">
        {quickSlots.map((s) => (
          <div key={s.name} className={styles.slot}>
            <div className={styles.slotThumb} style={{ background: s.tone }}>
              {!s.uploaded && <ToolIcon name="upload" size={16} />}
            </div>
            <div className={styles.slotText}>
              <span className={styles.slotName}>@{s.name}</span>
              <span className={styles.slotState} style={{ color: s.uploaded ? 'var(--c-success)' : 'var(--c-text-3)' }}>
                {s.uploaded ? t('tools.quick.slot.uploaded', { shots: s.shots ?? '' }) : t('tools.quick.slot.empty')}
              </span>
            </div>
            <button type="button" className={layout.chipBtn}>
              <FormattedMessage id={s.uploaded ? 'tools.quick.slot.replace' : 'tools.quick.slot.upload'} />
            </button>
          </div>
        ))}
      </AsideCard>
      <AsideCard
        title={t('tools.quick.lines')}
        testId="lines"
        end={
          <select aria-label={t('tools.quick.lines.language')} className={layout.select} defaultValue="en-US">
            <option value="en-US">English (US)</option>
            <option value="zh">Chinese (Mandarin)</option>
            <option value="ja">Japanese</option>
          </select>
        }
      >
        {quickLines.map((l, i) => (
          <div key={l.id} className={styles.line}>
            <span className={styles.lineHead}>
              <b>{l.who}</b>
              <span>{span(l.from, l.to)}</span>
            </span>
            <label htmlFor={`quick-${l.id}`} className="rl-visually-hidden">
              <FormattedMessage id="tools.quick.lineLabel" values={{ who: l.who }} />
            </label>
            <input
              id={`quick-${l.id}`}
              className={styles.lineInput}
              value={lines[i]}
              onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
        ))}
      </AsideCard>
      <AsideCard row testId="ambience">
        <span className={styles.ambience}>
          <FormattedMessage id="tools.quick.ambience" />
        </span>
        <ToolSwitch on={ambience} label={t('tools.quick.ambience')} onToggle={() => setAmbience((v) => !v)} />
      </AsideCard>
    </>
  );

  return (
    <ToolLayout
      testId="tool-quick"
      title={t('tools.quick.title', { template: quickTemplate.name })}
      count={t('tools.results', { n: feed.length })}
      feedMin={210}
      feed={feed}
      aside={aside}
      advanced={adv}
      advGroups={advGroups}
      composer={{
        noteLead: t('tools.quick.note'),
        noteChips: [adv ? t('tools.quick.note.chipAdv') : t('tools.quick.note.chip')],
        refs: [{ badge: '@Lead', tone: '#26232A' }],
        label: t('tools.quick.composer.label'),
        text,
        onText: setText,
        placeholder: t('tools.quick.composer.placeholder'),
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
      viewerAspect="9/16"
      initialOverlay={initialOverlay}
      isMember={isMember}
    />
  );
}
