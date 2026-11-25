import { PLANS, TOP_UP } from '@rolling/core/pricing/config';
import { Switch } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { setCreationMode, setLanguage, useCreationMode, useLanguagePref } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import { motion, PathIcon, Segmented } from './shared';
import { SelectMenu } from './shared/SelectMenu';
import { useAutoTopUp, useInvoices, useMe, useMembers, useTopUps, useUpdatePrefs, formatUsd, topUpFor } from './api';
import type { CreationMode, Me, Prefs, Role } from './types';
import styles from './Settings.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

export const SETTINGS_SECTIONS = ['account', 'preferences', 'billing', 'team', 'notifications'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(s: string): s is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(s);
}

const ICONS: Record<SettingsSection, string> = {
  account: 'M18 20a6 6 0 0 0-12 0 M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  preferences: 'M21 4h-7 M10 4H3 M21 12h-9 M8 12H3 M21 20h-5 M12 20H3 M14 2v4 M8 10v4 M16 18v4',
  billing: 'M2 7h20v12H2z M2 11h20',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  notifications: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0',
};

/** `/settings/$section` (Settings.dc.html). */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const intl = useIntl();
  const { data: me } = useMe();
  return (
    <div className={styles.page}>
      <nav aria-label={intl.formatMessage({ id: 'account.settings.title' })} className={styles.nav}>
        <h1 className={styles.title}>
          <FormattedMessage id="account.settings.title" />
        </h1>
        {SETTINGS_SECTIONS.map((s) => (
          <Link
            key={s}
            to="/settings/$section"
            params={{ section: s }}
            className={styles.navItem}
            aria-current={s === section ? 'page' : undefined}
            activeProps={{}}
          >
            <PathIcon d={ICONS[s]} size={16} />
            <FormattedMessage id={`account.settings.section.${s}`} />
          </Link>
        ))}
      </nav>
      <div className={styles.content}>
        {me && (
          <section key={section} aria-labelledby="settings-heading" className={motion.enter} data-testid="settings-section">
            {section === 'account' && <AccountSection me={me} />}
            {section === 'preferences' && <PreferencesSection me={me} />}
            {section === 'billing' && <BillingSection me={me} />}
            {section === 'team' && <TeamSection me={me} />}
            {section === 'notifications' && <NotificationsSection me={me} />}
          </section>
        )}
      </div>
    </div>
  );
}

function Head({ id, sub }: { id: string; sub?: ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <h2 id="settings-heading" className={styles.h2}>
        <FormattedMessage id={id} />
      </h2>
      {sub && <span className={styles.sectionSub}>{sub}</span>}
    </div>
  );
}

function Row({ label, hint, children, labelFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; labelFor?: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowText}>
        {labelFor ? (
          <label htmlFor={labelFor} className={styles.rowLabel}>
            {label}
          </label>
        ) : (
          <span className={styles.rowLabel}>{label}</span>
        )}
        {hint && <span className={styles.rowHint}>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Switch size="sm" className={styles.switch} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </Row>
  );
}

function AccountSection({ me }: { me: Me }) {
  const intl = useIntl();
  const [name, setName] = useState(me.user.name);
  const [handle, setHandle] = useState(`@${me.user.handle}`);
  const [email, setEmail] = useState(me.user.email);
  return (
    <>
      <Head id="account.settings.section.account" />
      <div className={styles.profileRow}>
        <span className={styles.avatarLg} aria-hidden="true">
          {me.user.name.slice(0, 1)}
        </span>
        <span className={styles.who}>
          <span className={styles.whoName}>{me.user.name}</span>
          <span className={styles.whoEmail}>{me.user.email}</span>
        </span>
        <button type="button" className={cx(styles.btn, motion.hover)}>
          <FormattedMessage id="account.settings.account.changePhoto" />
        </button>
      </div>
      <Row label={<FormattedMessage id="account.settings.account.name" />} labelFor="acc-name">
        <input id="acc-name" className={styles.field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </Row>
      <Row
        label={<FormattedMessage id="account.settings.account.username" />}
        hint={<FormattedMessage id="account.settings.account.username.hint" />}
        labelFor="acc-handle"
      >
        <input id="acc-handle" className={styles.field} value={handle} onChange={(e) => setHandle(e.target.value)} autoComplete="username" />
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.email" />} labelFor="acc-email">
        <input id="acc-email" type="email" className={styles.field} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.signIn" />}>
        <span className={styles.rowValue}>
          <FormattedMessage id={`account.settings.account.signIn.${me.user.signIn}`} />
          <button type="button" className={cx(styles.btn, motion.hover)} aria-label={intl.formatMessage({ id: 'account.settings.account.signIn.manage.label' })}>
            <FormattedMessage id="account.settings.account.signIn.manage" />
          </button>
        </span>
      </Row>
      <div className={styles.dangerWrap}>
        <button type="button" className={cx(styles.btn, styles.danger, motion.hover)}>
          <FormattedMessage id="account.settings.account.delete" />
        </button>
      </div>
    </>
  );
}

const LANGUAGES = ['en', 'ja', 'zh-TW', 'zh-HK', 'ko'] as const;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'TWD', 'HKD', 'KRW'] as const;
const RATIOS = ['9:16', '16:9', '1:1', '4:5'] as const;
const MODELS = ['auto', 'seedance-2.5', 'minimax-h3', 'wan-3.0'] as const;
/** 300 is the default (D-006, `DEFAULT_CONFIRM_THRESHOLD_CREDITS`). */
const THRESHOLDS = ['0', '100', '300', '1000'] as const;

function languageName(code: string) {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function PreferencesSection({ me }: { me: Me }) {
  const intl = useIntl();
  const update = useUpdatePrefs();
  const p = me.prefs;
  const set = (patch: Partial<Prefs>) => update.mutate(patch);
  // Creation mode and language are shared with the header settings popover (lib/prefs).
  const creationMode = useCreationMode();
  const language = useLanguagePref() ?? p.language;
  // D-005: the mature preference exists only for workspaces with an active plan that allow it.
  const showMature = useSession().matureAllowed;
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
  return (
    <>
      <Head id="account.settings.section.preferences" />
      <Row label={t('account.settings.prefs.language')}>
        <SelectMenu
          label={t('account.settings.prefs.language')}
          value={language}
          options={LANGUAGES.map((l) => ({ value: l, label: languageName(l) }))}
          onChange={(next) => {
            setLanguage(next);
            set({ language: next });
          }}
        />
      </Row>
      <Row label={t('account.settings.prefs.currency')} hint={t('account.settings.prefs.currency.hint')}>
        <SelectMenu
          label={t('account.settings.prefs.currency')}
          value={p.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(currency) => set({ currency })}
        />
      </Row>
      <Row label={t('account.settings.prefs.mode')} hint={t('account.settings.prefs.mode.hint')}>
        <Segmented<CreationMode>
          label={t('account.settings.prefs.mode')}
          value={creationMode}
          onChange={(next) => {
            setCreationMode(next);
            set({ creationMode: next });
          }}
          className={styles.seg}
          optionClassName={styles.segOption}
          indicatorClassName={styles.segFill}
          options={[
            { value: 'simple', label: t('account.settings.prefs.mode.simple') },
            { value: 'advanced', label: t('account.settings.prefs.mode.advanced') },
          ]}
        />
      </Row>
      <Row label={t('account.settings.prefs.ratio')}>
        <SelectMenu
          label={t('account.settings.prefs.ratio')}
          value={p.defaultRatio}
          options={RATIOS.map((r) => ({ value: r, label: r }))}
          onChange={(defaultRatio) => set({ defaultRatio })}
        />
      </Row>
      <Row label={t('account.settings.prefs.model')}>
        <SelectMenu
          label={t('account.settings.prefs.model')}
          value={p.defaultModel}
          options={MODELS.map((m) => ({ value: m, label: t(`account.settings.prefs.model.${m}`) }))}
          onChange={(defaultModel) => set({ defaultModel })}
        />
      </Row>
      <Row label={t('account.settings.prefs.confirm')} hint={t('account.settings.prefs.confirm.hint')}>
        <SelectMenu
          label={t('account.settings.prefs.confirm')}
          value={String(p.confirmThreshold)}
          options={THRESHOLDS.map((n) => ({
            value: n,
            label: n === '0' ? t('account.settings.prefs.confirm.always') : t('account.settings.prefs.confirm.over', { n: Number(n) }),
          }))}
          onChange={(v) => set({ confirmThreshold: Number(v) })}
        />
      </Row>
      {showMature && (
        <SwitchRow
          label={t('account.settings.prefs.mature')}
          hint={t('account.settings.prefs.mature.hint')}
          checked={p.matureContent}
          onChange={(matureContent) => set({ matureContent })}
        />
      )}
    </>
  );
}

function BillingSection({ me }: { me: Me }) {
  const intl = useIntl();
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const { data: packs = [] } = useTopUps(me.plan?.id ?? null);
  const { data: invoices = [] } = useInvoices();
  const autoTopUp = useAutoTopUp();
  const [packId, setPackId] = useState('topup_25');
  const plan = me.plan ? PLANS[me.plan.id] : null;
  const total = me.balance.plan + me.balance.purchased;
  const rest = plan ? Math.max(0, plan.monthlyCredits - me.balance.plan) : 0;
  const price = plan ? (me.plan!.period === 'yearly' ? Math.round((Number(plan.priceYearlyUsd) / 12) * 100) / 100 : Number(plan.priceMonthlyUsd)) : 0;
  const [custom, setCustom] = useState('');
  const customActive = custom.trim() !== '';
  const customUsd = Number(custom);
  const customError = !customActive
    ? null
    : !/^\d+(\.\d{1,2})?$/.test(custom.trim())
      ? 'account.settings.billing.custom.invalid'
      : customUsd < TOP_UP.minUsd
        ? 'account.settings.billing.custom.min'
        : customUsd > TOP_UP.maxUsd
          ? 'account.settings.billing.custom.max'
          : null;
  const preset = packs.find((p) => p.id === packId) ?? packs[0];
  const pack = customActive ? (customError ? null : topUpFor(customUsd, me.plan?.id ?? null)) : preset;
  const auto = topUpFor(me.autoTopUp.amountUsd, me.plan?.id ?? null);
  return (
    <>
      <Head id="account.settings.section.billing" />
      <div className={styles.cards}>
        <div className={styles.card}>
          <span className={styles.cardKey}>
            <FormattedMessage id="account.settings.billing.currentPlan" />
          </span>
          <span className={styles.cardValue}>
            {plan ? (
              <FormattedMessage id={`account.settings.billing.planName.${me.plan!.period}`} values={{ plan: plan.label }} />
            ) : (
              <FormattedMessage id="account.settings.billing.noPlan" />
            )}
          </span>
          <span className={styles.cardText}>
            {plan ? (
              <FormattedMessage
                id="account.settings.billing.renews"
                values={{ price: money(price), date: '[DATE]', credits: plan.monthlyCredits }}
              />
            ) : (
              <FormattedMessage id="account.settings.billing.noPlan.text" />
            )}
          </span>
          <div className={styles.cardActions}>
            <Link to="/upgrade" className={cx(styles.btn, styles.btnPrimary, motion.press)}>
              <FormattedMessage id={plan ? 'account.settings.billing.changePlan' : 'account.settings.billing.pickPlan'} />
            </Link>
            {plan && (
              <button type="button" className={cx(styles.btn, motion.hover)}>
                <FormattedMessage id="account.settings.billing.cancelPlan" />
              </button>
            )}
          </div>
        </div>
        <div className={styles.card}>
          <span className={styles.cardKey}>
            <FormattedMessage id="account.settings.billing.credits" />
          </span>
          <span className={styles.cardValue}>{intl.formatNumber(total)}</span>
          <div className={styles.split} aria-hidden="true">
            <span className={cx(styles.splitPart, styles.splitPlan)} style={{ flexGrow: me.balance.plan }} />
            <span className={cx(styles.splitPart, styles.splitBought)} style={{ flexGrow: me.balance.purchased }} />
            <span className={cx(styles.splitPart, styles.splitRest)} style={{ flexGrow: rest }} />
          </div>
          <div className={styles.legend}>
            <span>
              <FormattedMessage id="account.settings.billing.planCredits" values={{ n: me.balance.plan, date: '[DATE]' }} />
            </span>
            <span>
              <FormattedMessage id="account.settings.billing.purchasedCredits" values={{ n: me.balance.purchased }} />
            </span>
          </div>
        </div>
      </div>
      <h3 className={styles.h3}>
        <FormattedMessage id="account.settings.billing.buy" />
      </h3>
      <div role="radiogroup" aria-label={intl.formatMessage({ id: 'account.settings.billing.buy' })} className={styles.packs}>
        {packs.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={!customActive && pack?.id === p.id}
            className={styles.pack}
            onClick={() => {
              setPackId(p.id);
              setCustom('');
            }}
          >
            <span className={styles.packCredits}>{intl.formatNumber(p.credits)}</span>
            <span className={styles.packPrice}>
              {money(p.amountUsd)}
              {p.bonusRate > 0 && (
                <>
                  {' · '}
                  <FormattedMessage id="account.settings.billing.packBonus" values={{ pct: p.bonusRate }} />
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      <div className={styles.buyRow}>
        <div className={styles.custom}>
          <label htmlFor="topup-custom" className={styles.customLabel}>
            <FormattedMessage id="account.settings.billing.custom" />
          </label>
          <span className={styles.customField} data-invalid={!!customError}>
            <span aria-hidden="true">$</span>
            <input
              id="topup-custom"
              inputMode="decimal"
              className={styles.customInput}
              placeholder={String(TOP_UP.minUsd)}
              value={custom}
              aria-invalid={!!customError}
              aria-describedby="topup-line"
              onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))}
            />
          </span>
          <span id="topup-line" className={cx(styles.customLine, !!customError && styles.customError)} role={customError ? 'alert' : undefined}>
            {customError ? (
              <FormattedMessage id={customError} values={{ min: money(TOP_UP.minUsd), max: money(TOP_UP.maxUsd) }} />
            ) : pack ? (
              <FormattedMessage
                id={pack.bonusCredits > 0 ? 'account.settings.billing.quote.bonus' : 'account.settings.billing.quote'}
                values={{ base: pack.credits - pack.bonusCredits, bonus: pack.bonusCredits, credits: pack.credits }}
              />
            ) : null}
          </span>
        </div>
        <button type="button" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={!plan || !pack}>
          {pack ? (
            <FormattedMessage id="account.settings.billing.buyN" values={{ n: pack.credits, price: money(pack.amountUsd) }} />
          ) : (
            <FormattedMessage id="account.settings.billing.buy" />
          )}
        </button>
      </div>
      <SwitchRow
        label={intl.formatMessage({ id: 'account.settings.billing.autoTopUp' })}
        hint={intl.formatMessage(
          { id: 'account.settings.billing.autoTopUp.hint' },
          { below: me.autoTopUp.below, buy: auto.credits, price: money(auto.amountUsd) },
        )}
        checked={me.autoTopUp.enabled}
        onChange={(v) => autoTopUp.mutate(v)}
      />
      <Row
        label={<FormattedMessage id="account.settings.billing.payment" />}
        hint={<FormattedMessage id="account.settings.billing.payment.hint" />}
      >
        <span className={cx(styles.rowValue, styles.rowValueWide)}>
          {me.paymentMethod && (
            <FormattedMessage id="account.settings.billing.card" values={{ brand: me.paymentMethod.brand, last4: me.paymentMethod.last4 }} />
          )}
          <button type="button" className={cx(styles.btn, motion.hover)}>
            <FormattedMessage id="account.settings.billing.update" />
          </button>
        </span>
      </Row>
      <h3 className={cx(styles.h3, styles.h3Invoices)}>
        <FormattedMessage id="account.settings.billing.invoices" />
      </h3>
      <div className={styles.invoices}>
        {invoices.map((inv) => (
          <div key={inv.id} className={styles.invoice}>
            <span className={styles.invoiceDate}>[DATE]</span>
            <span>
              {inv.kind === 'plan' ? (
                <FormattedMessage
                  id={`account.settings.billing.invoice.plan.${inv.period ?? 'monthly'}`}
                  values={{ plan: PLANS[inv.planId ?? 'pro'].label }}
                />
              ) : (
                <FormattedMessage
                  id="account.settings.billing.invoice.pack"
                  values={{ n: topUpFor(inv.amountUsd ?? 0, me.plan?.id ?? null).credits }}
                />
              )}
            </span>
            <span className={styles.invoiceAmount}>
              {money(inv.kind === 'plan' ? Number(PLANS[inv.planId ?? 'pro'].priceMonthlyUsd) : (inv.amountUsd ?? 0))}
            </span>
            <a href={`/api/billing/invoices/${inv.id}.pdf`} className={cx(styles.invoicePdf, motion.hover)}>
              <FormattedMessage id="account.settings.billing.pdf" />
            </a>
          </div>
        ))}
      </div>
    </>
  );
}

function TeamSection({ me }: { me: Me }) {
  const intl = useIntl();
  const { data: members = [] } = useMembers();
  const [roles, setRoles] = useState<Record<string, Role>>({});
  return (
    <>
      <Head id="account.settings.section.team" sub={<FormattedMessage id="account.settings.team.sub" values={{ workspace: me.workspace.name }} />} />
      {members.map((m) => {
        const role = roles[m.id] ?? m.role;
        return (
          <div key={m.id} className={styles.member}>
            <span className={styles.avatarSm} aria-hidden="true">
              {m.name.slice(0, 1)}
            </span>
            <span className={styles.memberText}>
              <span className={styles.memberName}>{m.name}</span>
              <span className={styles.memberEmail}>{m.email}</span>
            </span>
            <span className={styles.limit}>
              {role === 'viewer' ? (
                <FormattedMessage id="account.settings.team.viewOnly" />
              ) : m.monthlyCreditLimit === null ? (
                <FormattedMessage id="account.settings.team.noLimit" />
              ) : (
                <FormattedMessage id="account.settings.team.limit" values={{ n: m.monthlyCreditLimit }} />
              )}
            </span>
            <SelectMenu<Role>
              label={intl.formatMessage({ id: 'account.settings.team.role' }, { name: m.name })}
              value={role}
              options={(['owner', 'editor', 'viewer'] as const).map((r) => ({
                value: r,
                label: intl.formatMessage({ id: `account.settings.team.role.${r}` }),
              }))}
              onChange={(r) => setRoles((all) => ({ ...all, [m.id]: r }))}
            />
          </div>
        );
      })}
      <div className={styles.inviteWrap}>
        <button type="button" className={cx(styles.btn, styles.btnPrimary, motion.press)}>
          <FormattedMessage id="account.settings.team.invite" />
        </button>
      </div>
    </>
  );
}

function NotificationsSection({ me }: { me: Me }) {
  const intl = useIntl();
  const update = useUpdatePrefs();
  const n = me.prefs.notifications;
  const t = (id: string, values?: Record<string, number>) => intl.formatMessage({ id }, values);
  const set = (key: keyof Prefs['notifications']) => (v: boolean) => update.mutate({ notifications: { ...n, [key]: v } });
  return (
    <>
      <Head id="account.settings.section.notifications" />
      <SwitchRow
        label={t('account.settings.notify.finished')}
        hint={t('account.settings.notify.finished.hint')}
        checked={n.generationFinished}
        onChange={set('generationFinished')}
      />
      <SwitchRow
        label={t('account.settings.notify.low')}
        hint={t('account.settings.notify.low.hint', { n: me.autoTopUp.below })}
        checked={n.creditsLow}
        onChange={set('creditsLow')}
      />
      <SwitchRow label={t('account.settings.notify.renewal')} checked={n.planRenewal} onChange={set('planRenewal')} />
      <SwitchRow label={t('account.settings.notify.updates')} checked={n.productUpdates} onChange={set('productUpdates')} />
    </>
  );
}
