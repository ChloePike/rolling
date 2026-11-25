import { PLANS, TOP_UP } from '@rolling/core/pricing/config';
import { Dialog, Switch, useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { pickerModels, useModels } from '@/lib/models';
import {
  ASPECT_RATIO_OPTIONS,
  CONFIRM_THRESHOLD_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  languageOption,
  setPref,
  setPrefs,
  THEME_OPTIONS,
  usePrefs,
  type AspectRatioPref,
  type CreationMode,
  type CurrencyCode,
  type ThemePref,
} from '@/lib/prefs';
import { useSession } from '@/lib/session';
import { parseTopUpAmount } from '@/lib/topUp';
import { motion, PathIcon, paths, Segmented } from './shared';
import { SelectMenu } from './shared/SelectMenu';
import {
  ApiError,
  EMAIL_RE,
  HANDLE_RE,
  deleteAccount,
  formatUsd,
  invoiceFile,
  saveFile,
  topUpFor,
  useAutoTopUp,
  useBuyTopUp,
  useCancelPlan,
  useInviteMember,
  useInvoices,
  useMe,
  useMembers,
  usePatchMember,
  usePatchProfile,
  usePaymentMethod,
  useRemoveMember,
  useTopUps,
} from './api';
import { setNotifyPref, useNotifyPrefs, type NotifyKey } from './notifyPrefs';
import type { Invoice, Me, Member, Role } from './types';
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
            {section === 'preferences' && <PreferencesSection />}
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

/** Footer row for the settings dialogs. */
function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.dlgActions}>{children}</div>;
}

function useT() {
  const intl = useIntl();
  return (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
}

const PROFILE_FIELDS = ['name', 'handle', 'email'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

function AccountSection({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const save = usePatchProfile();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const initial = { name: me.user.name, handle: `@${me.user.handle}`, email: me.user.email };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [signInOpen, setSignInOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dirty = PROFILE_FIELDS.some((k) => form[k] !== initial[k]);

  function validate() {
    const e: Partial<Record<ProfileField, string>> = {};
    if (!form.name.trim()) e.name = t('account.settings.account.error.name');
    if (!HANDLE_RE.test(form.handle.replace(/^@/, ''))) e.handle = t('account.settings.account.error.handle');
    if (!EMAIL_RE.test(form.email.trim())) e.email = t('account.settings.account.error.email');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    try {
      await save.mutateAsync({ name: form.name.trim(), handle: form.handle.replace(/^@/, ''), email: form.email.trim() });
      toast.show({ message: t(form.email.trim() !== me.user.email ? 'account.settings.account.savedEmail' : 'account.settings.account.saved') });
    } catch {
      toast.show({ message: t('account.settings.account.saveFailed') });
    }
  }

  const field = (k: ProfileField, id: string, auto: string, type = 'text') => (
    <span className={styles.fieldWrap}>
      <input
        id={id}
        type={type}
        className={styles.field}
        value={form[k]}
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `${id}-err` : undefined}
        onChange={(e) => {
          setForm((f) => ({ ...f, [k]: e.target.value }));
          setErrors((er) => ({ ...er, [k]: undefined }));
        }}
        autoComplete={auto}
      />
      {errors[k] && (
        <span id={`${id}-err`} role="alert" className={cx(styles.fieldError, motion.enter)}>
          {errors[k]}
        </span>
      )}
    </span>
  );

  return (
    <form onSubmit={submit} noValidate>
      <Head id="account.settings.section.account" />
      <div className={styles.profileRow}>
        <span className={styles.avatarLg} aria-hidden="true" style={photo ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover' } : undefined}>
          {photo ? '' : me.user.name.slice(0, 1)}
        </span>
        <span className={styles.who}>
          <span className={styles.whoName}>{me.user.name}</span>
          <span className={styles.whoEmail}>{me.user.email}</span>
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="rl-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="photo-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setPhoto(URL.createObjectURL(f));
            toast.show({ message: t('account.settings.account.photoUpdated') });
            e.target.value = '';
          }}
        />
        <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => fileRef.current?.click()}>
          <FormattedMessage id="account.settings.account.changePhoto" />
        </button>
      </div>
      <Row label={<FormattedMessage id="account.settings.account.name" />} labelFor="acc-name">
        {field('name', 'acc-name', 'name')}
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.username" />} hint={<FormattedMessage id="account.settings.account.username.hint" />} labelFor="acc-handle">
        {field('handle', 'acc-handle', 'username')}
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.email" />} labelFor="acc-email">
        {field('email', 'acc-email', 'email', 'email')}
      </Row>
      {dirty && (
        <div className={cx(styles.saveBar, motion.enter)} data-testid="save-bar">
          <span className={styles.rowHint}>
            <FormattedMessage id="account.settings.account.unsaved" />
          </span>
          <button
            type="button"
            className={cx(styles.btn, motion.hover)}
            onClick={() => {
              setForm(initial);
              setErrors({});
            }}
          >
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button type="submit" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={save.isPending}>
            <FormattedMessage id={save.isPending ? 'account.settings.saving' : 'account.settings.save'} />
          </button>
        </div>
      )}
      <Row label={<FormattedMessage id="account.settings.account.signIn" />}>
        <span className={styles.rowValue}>
          <FormattedMessage id={`account.settings.account.signIn.${me.user.signIn}`} />
          <button type="button" className={cx(styles.btn, motion.hover)} aria-label={t('account.settings.account.signIn.manage.label')} onClick={() => setSignInOpen(true)}>
            <FormattedMessage id="account.settings.account.signIn.manage" />
          </button>
        </span>
      </Row>
      <div className={styles.dangerWrap}>
        <button type="button" className={cx(styles.btn, styles.danger, motion.hover)} onClick={() => setDeleteOpen(true)}>
          <FormattedMessage id="account.settings.account.delete" />
        </button>
      </div>
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} me={me} />
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          toast.show({ message: t('account.settings.account.deleted') });
          void navigate({ to: '/login' });
        }}
      />
    </form>
  );
}

function SignInDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const t = useT();
  const toast = useToast();
  const [linked, setLinked] = useState<Record<'google' | 'apple' | 'email', boolean>>({ google: me.user.signIn === 'google', apple: me.user.signIn === 'apple', email: true });
  const count = Object.values(linked).filter(Boolean).length;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('account.settings.signIn.title')} description={t('account.settings.signIn.lead')} closeLabel={t('account.settings.close')}>
      <div className={styles.dlgList}>
        {(['google', 'apple', 'email'] as const).map((p) => {
          const on = linked[p];
          const last = on && count === 1;
          return (
            <div key={p} className={styles.dlgRow} data-provider={p}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>
                  <FormattedMessage id={`account.settings.signIn.${p}`} />
                </span>
                <span className={styles.rowHint}>
                  <FormattedMessage id={on ? 'account.settings.signIn.connected' : 'account.settings.signIn.notConnected'} />
                </span>
              </span>
              <button
                type="button"
                className={cx(styles.btn, motion.hover)}
                disabled={last}
                title={last ? t('account.settings.signIn.lastMethod') : undefined}
                onClick={() => {
                  setLinked((l) => ({ ...l, [p]: !on }));
                  toast.show({ message: t(on ? 'account.settings.signIn.disconnected' : 'account.settings.signIn.linked', { provider: t(`account.settings.signIn.${p}`) }) });
                }}
              >
                <FormattedMessage id={on ? 'account.settings.signIn.disconnect' : 'account.settings.signIn.connect'} />
              </button>
            </div>
          );
        })}
      </div>
      {count === 1 && (
        <p className={styles.rowHint}>
          <FormattedMessage id="account.settings.signIn.lastMethod" />
        </p>
      )}
    </Dialog>
  );
}

function DeleteDialog({ open, onClose, onDeleted }: { open: boolean; onClose: () => void; onDeleted: () => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const word = t('account.settings.delete.word');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('account.settings.delete.title')} description={t('account.settings.delete.lead')} closeLabel={t('account.settings.close')}>
      <label htmlFor={id} className={styles.rowHint}>
        <FormattedMessage id="account.settings.delete.type" values={{ word }} />
      </label>
      <input id={id} className={cx(styles.field, styles.fieldFull)} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      <DialogActions>
        <button type="button" className={cx(styles.btn, motion.hover)} onClick={onClose}>
          <FormattedMessage id="account.settings.cancel" />
        </button>
        <button
          type="button"
          className={cx(styles.btn, styles.btnDanger, motion.press)}
          disabled={text.trim().toLowerCase() !== word.toLowerCase() || busy}
          onClick={async () => {
            setBusy(true);
            await deleteAccount();
            setBusy(false);
            onClose();
            onDeleted();
          }}
        >
          <FormattedMessage id={busy ? 'account.settings.delete.deleting' : 'account.settings.delete.confirm'} />
        </button>
      </DialogActions>
    </Dialog>
  );
}

/** Names until the catalog answers (D-002 launch video models). */
const FALLBACK_VIDEO_MODELS = [
  { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5' },
  { id: 'minimax/minimax-h3', name: 'MiniMax H3' },
  { id: 'alibaba/wan3.0', name: 'Wan 3.0' },
];

function PreferencesSection() {
  const intl = useIntl();
  const t = useT();
  const prefs = usePrefs();
  const video = useModels('video');
  const featured = pickerModels(video.data, { featuredOnly: true }).filter((m) => !m.matureOnly);
  const models = featured.length ? featured.map((m) => ({ id: m.id, name: m.name })) : FALLBACK_VIDEO_MODELS;
  const modelOptions = [{ value: 'auto', label: t('account.settings.prefs.model.auto') }, ...models.map((m) => ({ value: m.id, label: m.name }))];
  if (!modelOptions.some((o) => o.value === prefs.defaultModel)) modelOptions.push({ value: prefs.defaultModel, label: prefs.defaultModel });
  // D-005: the mature preference exists only for workspaces with an active plan that allow it.
  const showMature = useSession().matureAllowed;
  const language = languageOption(prefs.language ?? intl.locale) ?? LANGUAGE_OPTIONS[0]!;
  const currencyName = (c: string) => {
    try {
      return new Intl.DisplayNames([intl.locale], { type: 'currency' }).of(c) ?? c;
    } catch {
      return c;
    }
  };
  return (
    <>
      <Head id="account.settings.section.preferences" />
      <Row label={t('account.settings.prefs.language')} hint={language.translated ? undefined : t('account.settings.prefs.language.fallback')}>
        <SelectMenu
          label={t('account.settings.prefs.language')}
          value={language.tag}
          options={LANGUAGE_OPTIONS.map((l) => ({ value: l.tag, label: <span lang={l.tag}>{l.name}</span>, text: l.name }))}
          onChange={(tag) => setPrefs({ language: tag })}
        />
      </Row>
      <Row label={t('account.settings.prefs.currency')} hint={t('account.settings.prefs.currency.hint')}>
        <SelectMenu<CurrencyCode>
          label={t('account.settings.prefs.currency')}
          value={prefs.currency}
          options={CURRENCY_OPTIONS.map((c) => ({ value: c, label: c, hint: currencyName(c) }))}
          onChange={(c) => setPref('currency', c)}
        />
      </Row>
      <Row label={t('account.settings.prefs.mode')} hint={t('account.settings.prefs.mode.hint')}>
        <Segmented<CreationMode>
          label={t('account.settings.prefs.mode')}
          value={prefs.creationMode}
          onChange={(next) => setPref('creationMode', next)}
          className={styles.seg}
          optionClassName={styles.segOption}
          indicatorClassName={styles.segFill}
          options={[
            { value: 'simple', label: t('account.settings.prefs.mode.simple') },
            { value: 'advanced', label: t('account.settings.prefs.mode.advanced') },
          ]}
        />
      </Row>
      <Row label={t('account.settings.prefs.theme')} hint={t('account.settings.prefs.theme.hint')}>
        <Segmented<ThemePref>
          label={t('account.settings.prefs.theme')}
          value={prefs.theme}
          onChange={(next) => setPref('theme', next)}
          className={styles.seg}
          optionClassName={styles.segOption}
          indicatorClassName={styles.segFill}
          options={THEME_OPTIONS.map((th) => ({ value: th, label: t(`account.settings.prefs.theme.${th}`) }))}
        />
      </Row>
      <Row label={t('account.settings.prefs.ratio')}>
        <SelectMenu<AspectRatioPref>
          label={t('account.settings.prefs.ratio')}
          value={prefs.defaultAspectRatio}
          options={ASPECT_RATIO_OPTIONS.map((r) => ({ value: r, label: r }))}
          onChange={(r) => setPref('defaultAspectRatio', r)}
        />
      </Row>
      <Row label={t('account.settings.prefs.model')}>
        <SelectMenu label={t('account.settings.prefs.model')} value={prefs.defaultModel} options={modelOptions} onChange={(m) => setPref('defaultModel', m)} />
      </Row>
      <Row label={t('account.settings.prefs.confirm')} hint={t('account.settings.prefs.confirm.hint')}>
        <SelectMenu
          label={t('account.settings.prefs.confirm')}
          value={String(prefs.confirmThreshold)}
          options={[...new Set<number>([...CONFIRM_THRESHOLD_OPTIONS, prefs.confirmThreshold])].map((n) => ({
            value: String(n),
            label: n === 0 ? t('account.settings.prefs.confirm.always') : t('account.settings.prefs.confirm.over', { n }),
          }))}
          onChange={(v) => setPref('confirmThreshold', Number(v))}
        />
      </Row>
      {showMature && (
        <SwitchRow
          label={t('account.settings.prefs.mature')}
          hint={t('account.settings.prefs.mature.hint')}
          checked={prefs.matureContent}
          onChange={(v) => setPref('matureContent', v)}
        />
      )}
    </>
  );
}

function BillingSection({ me }: { me: Me }) {
  const intl = useIntl();
  const t = useT();
  const toast = useToast();
  const money = (n: number) => formatUsd(n, (v, o) => intl.formatNumber(v, o));
  const { data: topUps = [] } = useTopUps(me.plan?.id ?? null);
  const { data: invoices = [] } = useInvoices();
  const autoTopUp = useAutoTopUp();
  const buy = useBuyTopUp();
  const cancel = useCancelPlan();
  const [topUpId, setTopUpId] = useState('topup_25');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const plan = me.plan ? PLANS[me.plan.id] : null;
  const total = me.balance.plan + me.balance.purchased;
  const rest = plan ? Math.max(0, plan.monthlyCredits - me.balance.plan) : 0;
  const price = plan ? (me.plan!.period === 'yearly' ? Math.round((Number(plan.priceYearlyUsd) / 12) * 100) / 100 : Number(plan.priceMonthlyUsd)) : 0;
  const [custom, setCustom] = useState('');
  const parsed = parseTopUpAmount(custom);
  const customActive = parsed !== null;
  const customUsd = parsed && 'usd' in parsed ? parsed.usd : 0;
  const customError = parsed && 'error' in parsed ? `account.settings.billing.custom.${parsed.error}` : null;
  const preset = topUps.find((p) => p.id === topUpId) ?? topUps[0];
  const topUp = customActive ? (customError ? null : topUpFor(customUsd, me.plan?.id ?? null)) : preset;
  const auto = topUpFor(me.autoTopUp.amountUsd, me.plan?.id ?? null);

  async function purchase() {
    if (!topUp) return;
    try {
      const r = await buy.mutateAsync(topUp.amountUsd);
      setCustom('');
      toast.show({ message: t('account.topUps.bought', { n: r.credits }) });
    } catch (e) {
      toast.show({ message: t(e instanceof ApiError && e.code === 'NO_PLAN' ? 'account.topUps.membersOnly' : 'account.topUps.failed') });
    }
  }

  function download(inv: Invoice) {
    const label =
      inv.kind === 'plan'
        ? t(`account.settings.billing.invoice.plan.${inv.period ?? 'monthly'}`, { plan: PLANS[inv.planId ?? 'pro'].label })
        : t('account.settings.billing.invoice.topUp', { n: inv.credits ?? topUpFor(inv.amountUsd ?? 0, me.plan?.id ?? null).credits });
    const amount = money(inv.kind === 'plan' ? Number(PLANS[inv.planId ?? 'pro'].priceMonthlyUsd) : (inv.amountUsd ?? 0));
    const f = invoiceFile(inv, [`Rolling invoice ${inv.id}`, me.workspace.name, label, amount]);
    saveFile(f.name, f.blob);
    toast.show({ message: t('account.settings.billing.downloaded') });
  }

  return (
    <>
      <Head id="account.settings.section.billing" />
      <div className={styles.cards}>
        <div className={styles.card}>
          <span className={styles.cardKey}>
            <FormattedMessage id="account.settings.billing.currentPlan" />
          </span>
          <span className={styles.cardValue}>
            {plan ? <FormattedMessage id={`account.settings.billing.planName.${me.plan!.period}`} values={{ plan: plan.label }} /> : <FormattedMessage id="account.settings.billing.noPlan" />}
          </span>
          <span className={styles.cardText} data-testid="plan-status">
            {plan ? (
              me.cancelAtPeriodEnd ? (
                <FormattedMessage id="account.settings.billing.cancels" values={{ date: '[DATE]' }} />
              ) : (
                <FormattedMessage id="account.settings.billing.renews" values={{ price: money(price), date: '[DATE]', credits: plan.monthlyCredits }} />
              )
            ) : (
              <FormattedMessage id="account.settings.billing.noPlan.text" />
            )}
          </span>
          <div className={styles.cardActions}>
            <Link to="/upgrade" className={cx(styles.btn, styles.btnPrimary, motion.press)}>
              <FormattedMessage id={plan ? 'account.settings.billing.changePlan' : 'account.settings.billing.pickPlan'} />
            </Link>
            {plan &&
              (me.cancelAtPeriodEnd ? (
                <button
                  type="button"
                  className={cx(styles.btn, motion.hover)}
                  disabled={cancel.isPending}
                  onClick={async () => {
                    await cancel.mutateAsync(false);
                    toast.show({ message: t('account.settings.billing.resumed') });
                  }}
                >
                  <FormattedMessage id="account.settings.billing.resume" />
                </button>
              ) : (
                <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setCancelOpen(true)}>
                  <FormattedMessage id="account.settings.billing.cancelPlan" />
                </button>
              ))}
          </div>
        </div>
        <div className={styles.card}>
          <span className={styles.cardKey}>
            <FormattedMessage id="account.settings.billing.credits" />
          </span>
          <span className={styles.cardValue} data-testid="balance">
            {intl.formatNumber(total)}
          </span>
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
      <div role="radiogroup" aria-label={t('account.settings.billing.buy')} className={styles.topUps}>
        {topUps.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={!customActive && topUp?.id === p.id}
            className={styles.topUp}
            onClick={() => {
              setTopUpId(p.id);
              setCustom('');
            }}
          >
            <span className={styles.topUpCredits}>{intl.formatNumber(p.credits)}</span>
            <span className={styles.topUpPrice}>
              {money(p.amountUsd)}
              {p.bonusRate > 0 && (
                <>
                  {' · '}
                  <FormattedMessage id="account.settings.billing.topUpBonus" values={{ pct: p.bonusRate }} />
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
            ) : topUp ? (
              <FormattedMessage
                id={topUp.bonusCredits > 0 ? 'account.settings.billing.quote.bonus' : 'account.settings.billing.quote'}
                values={{ base: topUp.credits - topUp.bonusCredits, bonus: topUp.bonusCredits, credits: topUp.credits }}
              />
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className={cx(styles.btn, styles.btnPrimary, motion.press)}
          disabled={!plan || !topUp || buy.isPending}
          title={!plan ? t('account.topUps.membersOnly') : undefined}
          aria-busy={buy.isPending || undefined}
          onClick={() => void purchase()}
        >
          {buy.isPending ? (
            <FormattedMessage id="account.topUps.buying" />
          ) : topUp ? (
            <FormattedMessage id="account.settings.billing.buyN" values={{ n: topUp.credits, price: money(topUp.amountUsd) }} />
          ) : (
            <FormattedMessage id="account.settings.billing.buy" />
          )}
        </button>
      </div>
      <SwitchRow
        label={t('account.settings.billing.autoTopUp')}
        hint={t('account.settings.billing.autoTopUp.hint', { below: me.autoTopUp.below, buy: auto.credits, price: money(auto.amountUsd) })}
        checked={me.autoTopUp.enabled}
        onChange={(v) => autoTopUp.mutate(v, { onSuccess: () => toast.show({ message: t(v ? 'account.settings.billing.autoOn' : 'account.settings.billing.autoOff') }) })}
      />
      <Row label={<FormattedMessage id="account.settings.billing.payment" />} hint={<FormattedMessage id="account.settings.billing.payment.hint" />}>
        <span className={cx(styles.rowValue, styles.rowValueWide)}>
          {me.paymentMethod ? (
            <span data-testid="card">
              <FormattedMessage id="account.settings.billing.card" values={{ brand: me.paymentMethod.brand, last4: me.paymentMethod.last4 }} />
            </span>
          ) : (
            <FormattedMessage id="account.settings.billing.noCard" />
          )}
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setCardOpen(true)}>
            <FormattedMessage id={me.paymentMethod ? 'account.settings.billing.update' : 'account.settings.billing.addCard'} />
          </button>
        </span>
      </Row>
      <h3 className={cx(styles.h3, styles.h3Invoices)}>
        <FormattedMessage id="account.settings.billing.invoices" />
      </h3>
      <div className={styles.invoices}>
        {invoices.map((inv) => (
          <div key={inv.id} className={styles.invoice} data-invoice={inv.id}>
            <span className={styles.invoiceDate}>[DATE]</span>
            <span>
              {inv.kind === 'plan' ? (
                <FormattedMessage id={`account.settings.billing.invoice.plan.${inv.period ?? 'monthly'}`} values={{ plan: PLANS[inv.planId ?? 'pro'].label }} />
              ) : (
                <FormattedMessage id="account.settings.billing.invoice.topUp" values={{ n: inv.credits ?? topUpFor(inv.amountUsd ?? 0, me.plan?.id ?? null).credits }} />
              )}
            </span>
            <span className={styles.invoiceAmount}>{money(inv.kind === 'plan' ? Number(PLANS[inv.planId ?? 'pro'].priceMonthlyUsd) : (inv.amountUsd ?? 0))}</span>
            <button type="button" className={cx(styles.invoicePdf, motion.hover)} aria-label={t('account.settings.billing.pdf.label', { id: inv.id })} onClick={() => download(inv)}>
              <FormattedMessage id="account.settings.billing.pdf" />
            </button>
          </div>
        ))}
      </div>
      <CancelDialog
        open={cancelOpen}
        planLabel={plan?.label ?? ''}
        pending={cancel.isPending}
        onClose={() => setCancelOpen(false)}
        onConfirm={async () => {
          await cancel.mutateAsync(true);
          setCancelOpen(false);
          toast.show({ message: t('account.settings.billing.canceled') });
        }}
      />
      <CardDialog open={cardOpen} onClose={() => setCardOpen(false)} />
    </>
  );
}

function CancelDialog(p: { open: boolean; planLabel: string; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <Dialog
      open={p.open}
      onOpenChange={(o) => !o && p.onClose()}
      title={t('account.settings.cancel.title', { plan: p.planLabel })}
      description={t('account.settings.cancel.lead', { date: '[DATE]' })}
      closeLabel={t('account.settings.close')}
    >
      <DialogActions>
        <button type="button" className={cx(styles.btn, motion.hover)} onClick={p.onClose}>
          <FormattedMessage id="account.settings.cancel.keep" />
        </button>
        <button type="button" className={cx(styles.btn, styles.btnDanger, motion.press)} disabled={p.pending} onClick={p.onConfirm}>
          <FormattedMessage id={p.pending ? 'account.settings.saving' : 'account.settings.cancel.confirm'} />
        </button>
      </DialogActions>
    </Dialog>
  );
}

function CardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const update = usePaymentMethod();
  const [number, setNumber] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState<string | null>(null);
  const numId = useId();
  const expId = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ number, expires });
      toast.show({ message: t('account.settings.card.saved') });
      setNumber('');
      setExpires('');
      onClose();
    } catch (err) {
      setError(t(err instanceof ApiError && err.code === 'CARD_DECLINED' ? 'account.settings.card.declined' : 'account.settings.card.invalid'));
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('account.settings.card.title')} description={t('account.settings.card.lead')} closeLabel={t('account.settings.close')}>
      <form className={styles.dlgForm} onSubmit={submit} noValidate>
        <label htmlFor={numId} className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.card.number" />
        </label>
        <input id={numId} className={cx(styles.field, styles.fieldFull)} inputMode="numeric" autoComplete="cc-number" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, ''))} placeholder="4242 4242 4242 4242" />
        <label htmlFor={expId} className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.card.expires" />
        </label>
        <input id={expId} className={styles.field} autoComplete="cc-exp" value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="MM/YY" />
        {error && (
          <p role="alert" className={cx(styles.fieldError, motion.enter)}>
            {error}
          </p>
        )}
        <DialogActions>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={onClose}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button type="submit" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={update.isPending}>
            <FormattedMessage id={update.isPending ? 'account.settings.saving' : 'account.settings.card.save'} />
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

const ROLES: Role[] = ['owner', 'editor', 'viewer'];

function TeamSection({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const { data: members = [] } = useMembers();
  const patch = usePatchMember();
  const remove = useRemoveMember();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [limitFor, setLimitFor] = useState<Member | null>(null);
  const [removeFor, setRemoveFor] = useState<Member | null>(null);
  const seats = me.plan ? PLANS[me.plan.id].seats : 1;
  return (
    <>
      <Head id="account.settings.section.team" sub={<FormattedMessage id="account.settings.team.sub" values={{ workspace: me.workspace.name }} />} />
      {members.map((m) => {
        const self = m.email === me.user.email;
        return (
          <div key={m.id} className={styles.member} data-member={m.id}>
            <span className={styles.avatarSm} aria-hidden="true">
              {m.name.slice(0, 1)}
            </span>
            <span className={styles.memberText}>
              <span className={styles.memberName}>
                {m.name}
                {m.invited && (
                  <span className={styles.invited}>
                    <FormattedMessage id="account.settings.team.invited" />
                  </span>
                )}
              </span>
              <span className={styles.memberEmail}>{m.email}</span>
            </span>
            <button
              type="button"
              className={cx(styles.limit, styles.limitBtn, motion.hover)}
              disabled={m.role === 'viewer'}
              aria-label={t('account.settings.team.limit.edit', { name: m.name })}
              onClick={() => setLimitFor(m)}
            >
              {m.role === 'viewer' ? (
                <FormattedMessage id="account.settings.team.viewOnly" />
              ) : m.monthlyCreditLimit === null ? (
                <FormattedMessage id="account.settings.team.noLimit" />
              ) : (
                <FormattedMessage id="account.settings.team.limit" values={{ n: m.monthlyCreditLimit }} />
              )}
            </button>
            <SelectMenu<Role>
              label={t('account.settings.team.role', { name: m.name })}
              value={m.role}
              options={ROLES.map((r) => ({ value: r, label: t(`account.settings.team.role.${r}`) }))}
              onChange={(r) =>
                patch.mutate({ id: m.id, patch: { role: r } }, { onSuccess: () => toast.show({ message: t('account.settings.team.roleChanged', { name: m.name, role: t(`account.settings.team.role.${r}`) }) }) })
              }
            />
            <button
              type="button"
              className={cx(styles.iconBtn, motion.hover)}
              disabled={self}
              title={self ? t('account.settings.team.remove.self') : undefined}
              aria-label={t('account.settings.team.remove', { name: m.name })}
              onClick={() => setRemoveFor(m)}
            >
              <PathIcon d={paths.trash} size={15} />
            </button>
          </div>
        );
      })}
      <div className={styles.inviteWrap}>
        <button
          type="button"
          className={cx(styles.btn, styles.btnPrimary, motion.press)}
          disabled={members.length >= seats}
          title={members.length >= seats ? t('account.settings.team.seatsFull', { n: seats }) : undefined}
          onClick={() => setInviteOpen(true)}
        >
          <FormattedMessage id="account.settings.team.invite" />
        </button>
        <span className={styles.rowHint}>
          <FormattedMessage id="account.settings.team.seats" values={{ used: members.length, n: seats }} />
        </span>
      </div>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <LimitDialog member={limitFor} onClose={() => setLimitFor(null)} />
      <Dialog
        open={!!removeFor}
        onOpenChange={(o) => !o && setRemoveFor(null)}
        title={t('account.settings.team.remove.title', { name: removeFor?.name ?? '' })}
        description={t('account.settings.team.remove.lead')}
        closeLabel={t('account.settings.close')}
      >
        <DialogActions>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setRemoveFor(null)}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button
            type="button"
            className={cx(styles.btn, styles.btnDanger, motion.press)}
            disabled={remove.isPending}
            onClick={() => {
              const m = removeFor!;
              remove.mutate(m.id, {
                onSuccess: () => {
                  setRemoveFor(null);
                  toast.show({ message: t('account.settings.team.removed', { name: m.name }) });
                },
              });
            }}
          >
            <FormattedMessage id="account.settings.team.remove.confirm" />
          </button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const invite = useInviteMember();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const limitId = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError(t('account.settings.account.error.email'));
    const n = limit.trim() ? Number(limit) : null;
    await invite.mutateAsync({ email: email.trim(), role, monthlyCreditLimit: role === 'viewer' ? null : n });
    toast.show({ message: t('account.settings.team.inviteSent', { email: email.trim() }) });
    setEmail('');
    setLimit('');
    onClose();
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('account.settings.team.invite.title')} description={t('account.settings.team.invite.lead')} closeLabel={t('account.settings.close')}>
      <form className={styles.dlgForm} onSubmit={submit} noValidate>
        <label htmlFor={emailId} className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.account.email" />
        </label>
        <input
          id={emailId}
          type="email"
          className={cx(styles.field, styles.fieldFull)}
          value={email}
          aria-invalid={!!error}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          placeholder="name@company.com"
        />
        {error && (
          <p role="alert" className={cx(styles.fieldError, motion.enter)}>
            {error}
          </p>
        )}
        <span className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.team.invite.role" />
        </span>
        <Segmented<Role>
          label={t('account.settings.team.invite.role')}
          value={role}
          onChange={setRole}
          className={styles.seg}
          optionClassName={styles.segOption}
          indicatorClassName={styles.segFill}
          options={(['editor', 'viewer'] as const).map((r) => ({ value: r, label: t(`account.settings.team.role.${r}`) }))}
        />
        {role !== 'viewer' && (
          <>
            <label htmlFor={limitId} className={styles.dlgLabel}>
              <FormattedMessage id="account.settings.team.invite.limit" />
            </label>
            <input id={limitId} inputMode="numeric" className={styles.field} value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} placeholder={t('account.settings.team.noLimit')} />
          </>
        )}
        <DialogActions>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={onClose}>
            <FormattedMessage id="account.settings.cancel" />
          </button>
          <button type="submit" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={invite.isPending}>
            <FormattedMessage id={invite.isPending ? 'account.settings.saving' : 'account.settings.team.invite.send'} />
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function LimitDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const patch = usePatchMember();
  const [value, setValue] = useState('');
  const [last, setLast] = useState<string | null>(null);
  const id = useId();
  if (member && member.id !== last) {
    setLast(member.id);
    setValue(member.monthlyCreditLimit === null ? '' : String(member.monthlyCreditLimit));
  }
  const save = (n: number | null) =>
    patch.mutate(
      { id: member!.id, patch: { monthlyCreditLimit: n } },
      {
        onSuccess: () => {
          toast.show({ message: t('account.settings.team.limitSaved', { name: member!.name }) });
          setLast(null);
          onClose();
        },
      },
    );
  return (
    <Dialog
      open={!!member}
      onOpenChange={(o) => {
        if (!o) {
          setLast(null);
          onClose();
        }
      }}
      title={t('account.settings.team.limit.title', { name: member?.name ?? '' })}
      description={t('account.settings.team.limit.lead')}
      closeLabel={t('account.settings.close')}
    >
      <form
        className={styles.dlgForm}
        onSubmit={(e) => {
          e.preventDefault();
          save(value.trim() ? Number(value) : null);
        }}
      >
        <label htmlFor={id} className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.team.invite.limit" />
        </label>
        <input id={id} inputMode="numeric" className={styles.field} value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} placeholder={t('account.settings.team.noLimit')} />
        <DialogActions>
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => save(null)}>
            <FormattedMessage id="account.settings.team.noLimit" />
          </button>
          <button type="submit" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={patch.isPending}>
            <FormattedMessage id="account.settings.save" />
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

const NOTIFY_ROWS: Array<{ key: NotifyKey | 'generationFinished'; label: string; hint?: string }> = [
  { key: 'generationFinished', label: 'account.settings.notify.finished', hint: 'account.settings.notify.finished.hint' },
  { key: 'creditsLow', label: 'account.settings.notify.low', hint: 'account.settings.notify.low.hint' },
  { key: 'planRenewal', label: 'account.settings.notify.renewal' },
  { key: 'productUpdates', label: 'account.settings.notify.updates' },
];

function NotificationsSection({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const notifyWhenDone = usePrefs().notifyWhenDone;
  const rest = useNotifyPrefs();
  return (
    <>
      <Head id="account.settings.section.notifications" />
      {NOTIFY_ROWS.map((r) => {
        const checked = r.key === 'generationFinished' ? notifyWhenDone : rest[r.key];
        return (
          <SwitchRow
            key={r.key}
            label={t(r.label)}
            hint={r.hint ? t(r.hint, { n: me.autoTopUp.below }) : undefined}
            checked={checked}
            onChange={(v) => {
              // "Generation finished" is the same preference as the header popover's "Notify when done".
              if (r.key === 'generationFinished') setPref('notifyWhenDone', v);
              else setNotifyPref(r.key, v);
              toast.show({ message: t(v ? 'account.settings.notify.on' : 'account.settings.notify.off', { name: t(r.label) }) });
            }}
          />
        );
      })}
    </>
  );
}
