import { planMonthlyCredits, PLANS, TOP_UP, teamPriceCents } from '@rolling/core/pricing/config';
import { Dialog, Skeleton, Switch, useToast } from '@rolling/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { pickerModels, useModels } from '@/lib/models';
import {
  ASPECT_RATIO_OPTIONS,
  CONFIRM_THRESHOLD_OPTIONS,
  LANGUAGE_OPTIONS,
  languageOption,
  setPref,
  setPrefs,
  THEME_OPTIONS,
  usePrefs,
  type AspectRatioPref,
  type CreationMode,
  type ThemePref,
} from '@/lib/prefs';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { LedgerLine } from '@/lib/api/types';
import { ME_KEY, openBillingPortal, signOut, useCredits, useSession } from '@/lib/session';
import { parseTopUpAmount } from '@/lib/topUp';
import { motion, PathIcon, paths, Segmented } from './shared';
import { SelectMenu } from './shared/SelectMenu';
import {
  accountsKey,
  ApiError,
  BIO_MAX,
  confirmEmailChange,
  EMAIL_RE,
  meKey,
  requestEmailChange,
  requestDataExport,
  dataExportKey,
  useDataExport,
  sendDeleteCode,
  uploadAvatar,
  errorCode,
  fetchLedgerPage,
  linkProvider,
  usePrepareGoogleLink,
  unlinkProvider,
  useLedger,
  useLinkedAccounts,
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
import { SeatsDialog } from './team/TeamDialogs';
import { openUpgrade } from '@/lib/upgrade/store';
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
        {!me && (
          // `/api/me` in flight: the section's heading and rows as placeholders (no sample account values).
          <div aria-busy="true" data-testid="settings-skeleton">
            <div className={styles.sectionHead}>
              <Skeleton width={160} height={22} />
              <Skeleton width={280} height={13} />
            </div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={styles.row}>
                <Skeleton width={120} height={14} />
                <Skeleton width="40%" height={14} />
              </div>
            ))}
          </div>
        )}
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

function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row label={label} hint={hint}>
      <Switch size="sm" className={styles.switch} checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
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

/** "Dec 1" for an epoch ms (period ends, invoice dates); an em dash when unknown. */
function useShortDate() {
  const intl = useIntl();
  return (ms: number | null | undefined) => (ms ? intl.formatDate(ms, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }) : '—');
}

const PROFILE_FIELDS = ['name', 'handle', 'bio', 'email'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

function AccountSection({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const save = usePatchProfile();
  const fileRef = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<string | null>(me.user.image ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const initial = { name: me.user.name, handle: me.user.handle ? `@${me.user.handle}` : '', bio: me.user.bio ?? '', email: me.user.email };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [signInOpen, setSignInOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [emailChange, setEmailChange] = useState<string | null>(null);
  const dirty = PROFILE_FIELDS.some((k) => form[k] !== initial[k]);
  useEffect(() => setPhoto(me.user.image ?? null), [me.user.image]);

  function validate() {
    const e: Partial<Record<ProfileField, string>> = {};
    const handle = form.handle.trim().replace(/^@/, '').toLowerCase();
    if (!form.name.trim()) e.name = t('account.settings.account.error.name');
    if ((handle || initial.handle) && !HANDLE_RE.test(handle)) e.handle = t('account.settings.account.error.handle');
    if (form.bio.length > BIO_MAX) e.bio = t('account.settings.account.error.bio', { max: BIO_MAX });
    if (!EMAIL_RE.test(form.email.trim())) e.email = t('account.settings.account.error.email');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    const handle = form.handle.trim().replace(/^@/, '').toLowerCase();
    const email = form.email.trim();
    const emailChanged = email.toLowerCase() !== me.user.email.toLowerCase();
    try {
      const patch = {
        ...(form.name !== initial.name ? { name: form.name.trim() } : {}),
        ...(form.handle !== initial.handle && handle ? { handle } : {}),
        ...(form.bio !== initial.bio ? { bio: form.bio.trim() || null } : {}),
      };
      if (Object.keys(patch).length) await save.mutateAsync(patch);
      if (emailChanged) {
        // The new address gets a code; the email changes once it is entered.
        await requestEmailChange(email);
        setEmailChange(email);
        setForm((f) => ({ ...f, email: me.user.email }));
        return;
      }
      toast.show({ message: t('account.settings.account.saved') });
    } catch (e) {
      const code = errorCode(e);
      if (code === 'HANDLE_TAKEN') return setErrors({ handle: t('account.settings.account.error.handleTaken') });
      if (code === 'RATE_LIMITED') return toast.show({ message: t('account.settings.account.email.wait') });
      toast.show({ message: t('account.settings.account.saveFailed') });
    }
  }

  async function changePhoto(file: File) {
    const prev = photo;
    setPhotoBusy(true);
    try {
      setPhoto(await uploadAvatar(file));
      toast.show({ message: t('account.settings.account.photoUpdated') });
      if (isMockApi()) void qc.invalidateQueries({ queryKey: meKey });
    } catch (e) {
      setPhoto(prev);
      const code = errorCode(e);
      toast.show({
        message: t(
          code === 'AVATAR_REJECTED' ? 'account.settings.account.photoRejected' : code === 'SAFETY_UNAVAILABLE' ? 'account.settings.account.photoCheckDown' : 'account.settings.account.photoFailed',
        ),
      });
    } finally {
      setPhotoBusy(false);
    }
  }

  const field = (k: ProfileField, id: string, auto: string, type = 'text', placeholder?: string) => (
    <span className={styles.fieldWrap}>
      <input
        id={id}
        type={type}
        className={cx(styles.field, k === 'bio' && styles.fieldWide)}
        value={form[k]}
        placeholder={placeholder}
        maxLength={k === 'bio' ? BIO_MAX : undefined}
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
        <span className={styles.avatarLg} aria-hidden="true" data-testid="account-avatar" style={photo ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
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
            e.target.value = '';
            if (f) void changePhoto(f);
          }}
        />
        <button type="button" className={cx(styles.btn, motion.hover)} disabled={photoBusy} aria-busy={photoBusy || undefined} onClick={() => fileRef.current?.click()}>
          <FormattedMessage id={photoBusy ? 'account.settings.account.photoUploading' : 'account.settings.account.changePhoto'} />
        </button>
      </div>
      <Row label={<FormattedMessage id="account.settings.account.name" />} labelFor="acc-name">
        {field('name', 'acc-name', 'name')}
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.username" />} hint={<FormattedMessage id="account.settings.account.username.hint" />} labelFor="acc-handle">
        {field('handle', 'acc-handle', 'username', 'text', t('account.settings.account.username.placeholder'))}
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.bio" />} hint={<FormattedMessage id="account.settings.account.bio.hint" values={{ max: BIO_MAX }} />} labelFor="acc-bio">
        {field('bio', 'acc-bio', 'off', 'text', t('account.settings.account.bio.placeholder'))}
      </Row>
      <Row label={<FormattedMessage id="account.settings.account.email" />} hint={<FormattedMessage id="account.settings.account.email.hint" />} labelFor="acc-email">
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
      <LinkErrorNotice />
      <ExportDataRow email={me.user.email} />
      <div className={styles.dangerWrap}>
        <button type="button" className={cx(styles.btn, styles.danger, motion.hover)} onClick={() => setDeleteOpen(true)}>
          <FormattedMessage id="account.settings.account.delete" />
        </button>
      </div>
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} me={me} />
      <EmailChangeDialog
        email={emailChange}
        onClose={() => setEmailChange(null)}
        onChanged={(email) => {
          setEmailChange(null);
          setForm((f) => ({ ...f, email }));
          void qc.invalidateQueries({ queryKey: ME_KEY });
          if (isMockApi()) void qc.invalidateQueries({ queryKey: meKey });
          toast.show({ message: t('account.settings.account.emailChanged', { email }) });
        }}
      />
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          // The server ended every session; forget the cached one (real API).
          if (!isMockApi()) void signOut();
          toast.show({ message: t('account.settings.account.deleted') });
          void navigate({ to: '/login' });
        }}
      />
    </form>
  );
}

/** Google linking fallbacks come back to `/settings/account?error=<code>` (routes/auth.ts `failTo`). */
const LINK_ERRORS = new Set(['account_in_use', 'access_denied', 'email_not_verified', 'unavailable', 'nonce']);

export function linkErrorMessage(code: string): string {
  return `account.settings.account.linkError.${LINK_ERRORS.has(code) ? code : 'generic'}`;
}

function LinkErrorNotice() {
  const search = useSearch({ strict: false }) as { error?: string };
  const navigate = useNavigate();
  if (!search.error) return null;
  return (
    <div className={cx(styles.notice, motion.enter)} role="alert" data-testid="link-error">
      <span className={styles.rowHint}>
        <FormattedMessage id={linkErrorMessage(search.error)} />
      </span>
      <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => void navigate({ to: '/settings/$section', params: { section: 'account' }, search: {}, replace: true })}>
        <FormattedMessage id="account.settings.account.linkError.dismiss" />
      </button>
    </div>
  );
}

/**
 * Settings → Account → Export my data: `POST /api/account/export` builds a
 * bundle and emails a 7-day download link; one request per 24 hours.
 */
function ExportDataRow({ email }: { email: string }) {
  const t = useT();
  const intl = useIntl();
  const toast = useToast();
  const qc = useQueryClient();
  const latest = useDataExport();
  const [busy, setBusy] = useState(false);
  const last = latest.data ?? null;
  const when = (ms: number) => intl.formatDate(ms, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const coolingDown = !!last && last.status !== 'failed' && last.nextAvailableAt > Date.now();
  const hint = !last || !coolingDown
    ? t('account.settings.account.export.hint')
    : last.status === 'done' && last.expiresAt
      ? t('account.settings.account.export.ready', { expires: when(last.expiresAt) })
      : t('account.settings.account.export.pending', { email });

  async function start() {
    setBusy(true);
    try {
      const r = await requestDataExport();
      qc.setQueryData(dataExportKey, r.export);
      toast.show({ message: t('account.settings.account.export.requested', { email: r.email }) });
    } catch (e) {
      if (errorCode(e) === 'RATE_LIMITED') {
        void qc.invalidateQueries({ queryKey: dataExportKey });
        toast.show({ message: t('account.settings.account.export.wait') });
      } else toast.show({ message: t('account.settings.account.export.failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row label={<FormattedMessage id="account.settings.account.export" />} hint={<span data-testid="export-hint">{hint}</span>}>
      <button
        type="button"
        className={cx(styles.btn, motion.hover)}
        aria-label={t('account.settings.account.export')}
        disabled={busy || coolingDown}
        aria-busy={busy || undefined}
        title={coolingDown && last ? t('account.settings.account.export.nextAt', { time: when(last.nextAvailableAt) }) : undefined}
        onClick={() => void start()}
      >
        <FormattedMessage id={busy ? 'account.settings.account.export.requesting' : 'account.settings.account.export.button'} />
      </button>
    </Row>
  );
}

function SignInDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: Me }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const accounts = useLinkedAccounts();
  // D-017: "Connect" opens Google's popup in the click, so the token client is prepared now.
  usePrepareGoogleLink();
  const [mockLinked, setMockLinked] = useState<Record<'google' | 'email', boolean>>({ google: me.user.signIn === 'google', email: true });
  const ids = (accounts.data ?? []).map((a) => a.providerId);
  // Real API: email codes always work for the account's address; social methods come from `list-accounts`.
  const linked = isMockApi() ? mockLinked : { google: ids.includes('google'), email: true };
  const [busy, setBusy] = useState<string | null>(null);
  const count = Object.values(linked).filter(Boolean).length;
  async function toggle(p: 'google' | 'email', on: boolean) {
    const name = t(`account.settings.signIn.${p}`);
    if (isMockApi()) {
      setMockLinked((l) => ({ ...l, [p]: !on }));
      toast.show({ message: t(on ? 'account.settings.signIn.disconnected' : 'account.settings.signIn.linked', { provider: name }) });
      return;
    }
    if (p === 'email') return;
    setBusy(p);
    try {
      if (!on) {
        if ((await linkProvider(p)) === 'linked') {
          await qc.invalidateQueries({ queryKey: accountsKey });
          toast.show({ message: t('account.settings.signIn.linked', { provider: name }) });
        }
      } else {
        await unlinkProvider(p);
        await qc.invalidateQueries({ queryKey: accountsKey });
        toast.show({ message: t('account.settings.signIn.disconnected', { provider: name }) });
      }
    } catch {
      toast.show({ message: t('account.settings.signIn.failed', { provider: name }) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('account.settings.signIn.title')} description={t('account.settings.signIn.lead')} closeLabel={t('account.settings.close')}>
      <div className={styles.dlgList}>
        {(['google', 'email'] as const).map((p) => {
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
                disabled={last || busy !== null || (!isMockApi() && p === 'email')}
                aria-busy={busy === p || undefined}
                title={last ? t('account.settings.signIn.lastMethod') : !isMockApi() && p === 'email' ? t('account.settings.signIn.emailAlways') : undefined}
                onClick={() => void toggle(p, on)}
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

/** Six-digit code field shared by the email change and delete dialogs. */
function CodeField({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <input
      id={id}
      className={cx(styles.field, styles.fieldFull)}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      aria-invalid={invalid}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

function codeError(t: ReturnType<typeof useT>, e: unknown): string {
  const code = errorCode(e);
  if (code === 'INVALID_CODE') return t('account.settings.code.invalid');
  if (code === 'CODE_EXPIRED') return t('account.settings.code.expired');
  if (code === 'TOO_MANY_ATTEMPTS') return t('account.settings.code.tooMany');
  if (code === 'RATE_LIMITED') return t('account.settings.code.wait');
  if (code === 'CONFLICT') return t('account.settings.account.email.inUse');
  return t('account.settings.code.failed');
}

/** Email change (Better Auth email OTP): the code went to `email`; entering it switches the account's address. */
function EmailChangeDialog({ email, onClose, onChanged }: { email: string | null; onClose: () => void; onChanged: (email: string) => void }) {
  const t = useT();
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'resend' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCode('');
    setError(null);
  }, [email]);
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!email || code.length !== 6) return;
    setBusy('confirm');
    try {
      await confirmEmailChange(email, code);
      onChanged(email);
    } catch (err) {
      setError(codeError(t, err));
      setCode('');
    } finally {
      setBusy(null);
    }
  }
  async function resend() {
    if (!email) return;
    setBusy('resend');
    try {
      await requestEmailChange(email);
      setError(null);
    } catch (err) {
      setError(codeError(t, err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog
      open={email !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t('account.settings.emailChange.title')}
      description={t('account.settings.emailChange.lead', { email: email ?? '' })}
      closeLabel={t('account.settings.close')}
    >
      <form className={styles.dlgForm} onSubmit={confirm} noValidate>
        <label htmlFor={id} className={styles.dlgLabel}>
          <FormattedMessage id="account.settings.code.label" />
        </label>
        <CodeField id={id} value={code} onChange={(v) => (setCode(v), setError(null))} invalid={!!error} />
        {error && (
          <p role="alert" className={cx(styles.fieldError, motion.enter)}>
            {error}
          </p>
        )}
        <DialogActions>
          <button type="button" className={cx(styles.btn, motion.hover)} disabled={busy !== null} onClick={() => void resend()}>
            <FormattedMessage id={busy === 'resend' ? 'account.settings.code.sending' : 'account.settings.code.resend'} />
          </button>
          <button type="submit" className={cx(styles.btn, styles.btnPrimary, motion.press)} disabled={code.length !== 6 || busy !== null}>
            <FormattedMessage id={busy === 'confirm' ? 'account.settings.saving' : 'account.settings.emailChange.confirm'} />
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/**
 * Delete account: send a code to the account's email, enter it, delete. A Team
 * you own with other members must get a new owner first (`OWNER_OF_TEAM`).
 */
function DeleteDialog({ open, onClose, onDeleted }: { open: boolean; onClose: () => void; onDeleted: () => void }) {
  const t = useT();
  const id = useId();
  const [step, setStep] = useState<'intro' | 'code'>('intro');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setStep('intro');
    setCode('');
    setError(null);
    setBlockedBy(null);
  }, [open]);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await sendDeleteCode();
      setSentTo(r.email);
      setStep('code');
    } catch (e) {
      if (isApiError(e, 'OWNER_OF_TEAM')) setBlockedBy(((e.data as { workspaces?: { name: string }[] }).workspaces ?? []).map((w) => w.name));
      else setError(codeError(t, e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    try {
      await deleteAccount(code);
      onClose();
      onDeleted();
    } catch (err) {
      if (isApiError(err, 'OWNER_OF_TEAM')) {
        setStep('intro');
        setBlockedBy(((err.data as { workspaces?: { name: string }[] }).workspaces ?? []).map((w) => w.name));
      } else {
        setError(codeError(t, err));
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('account.settings.delete.title')}
      description={t(step === 'code' ? 'account.settings.delete.codeLead' : 'account.settings.delete.lead', { email: sentTo })}
      closeLabel={t('account.settings.close')}
    >
      {blockedBy ? (
        <>
          <p role="alert" className={styles.rowHint} data-testid="delete-owner-of-team">
            <FormattedMessage id="account.settings.delete.ownerOfTeam" values={{ names: blockedBy.join(', '), n: blockedBy.length }} />
          </p>
          <DialogActions>
            <button type="button" className={cx(styles.btn, motion.hover)} onClick={onClose}>
              <FormattedMessage id="account.settings.close" />
            </button>
            <Link to="/settings/$section" params={{ section: 'team' }} className={cx(styles.btn, styles.btnPrimary, motion.press)} onClick={onClose}>
              <FormattedMessage id="account.settings.delete.toTeam" />
            </Link>
          </DialogActions>
        </>
      ) : step === 'intro' ? (
        <>
          <p className={styles.rowHint} data-testid="delete-privacy">
            <FormattedMessage
              id="account.settings.delete.privacy"
              values={{
                link: (chunks) => (
                  <Link to="/privacy" hash="when-you-delete-your-account" className={styles.inlineLink} onClick={onClose}>
                    {chunks}
                  </Link>
                ),
              }}
            />
          </p>
          {error && (
            <p role="alert" className={cx(styles.fieldError, motion.enter)}>
              {error}
            </p>
          )}
          <DialogActions>
            <button type="button" className={cx(styles.btn, motion.hover)} onClick={onClose}>
              <FormattedMessage id="account.settings.cancel" />
            </button>
            <button type="button" className={cx(styles.btn, styles.btnDanger, motion.press)} disabled={busy} aria-busy={busy || undefined} onClick={() => void send()}>
              <FormattedMessage id={busy ? 'account.settings.code.sending' : 'account.settings.delete.sendCode'} />
            </button>
          </DialogActions>
        </>
      ) : (
        <form className={styles.dlgForm} onSubmit={confirm} noValidate>
          <label htmlFor={id} className={styles.dlgLabel}>
            <FormattedMessage id="account.settings.code.label" />
          </label>
          <CodeField id={id} value={code} onChange={(v) => (setCode(v), setError(null))} invalid={!!error} />
          {error && (
            <p role="alert" className={cx(styles.fieldError, motion.enter)}>
              {error}
            </p>
          )}
          <DialogActions>
            <button type="button" className={cx(styles.btn, motion.hover)} disabled={busy} onClick={() => void send()}>
              <FormattedMessage id="account.settings.code.resend" />
            </button>
            <button type="submit" className={cx(styles.btn, styles.btnDanger, motion.press)} disabled={code.length !== 6 || busy}>
              <FormattedMessage id={busy ? 'account.settings.delete.deleting' : 'account.settings.delete.confirm'} />
            </button>
          </DialogActions>
        </form>
      )}
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
  // D-005: the mature preference needs an active plan and a workspace that allows it. Without a plan the
  // switch is shown off and opens the upgrade modal (it turns on once the plan is active).
  const session = useSession();
  const showMature = session.matureAllowed || (!session.isMember && session.workspaceMatureAllowed);
  const language = languageOption(prefs.language ?? intl.locale) ?? LANGUAGE_OPTIONS[0]!;
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
          checked={session.isMember && prefs.matureContent}
          onChange={(v) => (v && !session.isMember ? void openUpgrade({ kind: 'mature' }, { onResume: () => setPref('matureContent', true) }) : setPref('matureContent', v))}
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
  const [portal, setPortal] = useState(false);
  const date = useShortDate();
  const real = !isMockApi();
  const isOwner = me.role === 'owner';
  const plan = me.plan ? PLANS[me.plan.id] : null;
  const periodEnd = date(me.periodEnd);
  /** Real API: card, plan change, cancel and resume live in the Stripe customer portal. */
  async function toPortal() {
    setPortal(true);
    try {
      await openBillingPortal('/settings/billing');
    } catch (e) {
      setPortal(false);
      // No billing account yet: the shared API error handler opened the upgrade modal.
      if (isApiError(e, 'NO_PLAN')) return;
      toast.show({ message: t('account.settings.billing.portal.failed') });
    }
  }
  // Live balance shared with the header (lib/session).
  const credits = useCredits();
  const balance = { plan: credits.plan, purchased: credits.purchased };
  const total = credits.available;
  // Team prices and credits follow purchased seats (D-013).
  const seats = me.plan?.id === 'team' ? Math.max(1, me.plan.seats ?? 1) : 1;
  const planCredits = me.plan ? planMonthlyCredits(me.plan.id, seats) : 0;
  const rest = plan ? Math.max(0, planCredits - balance.plan) : 0;
  const price = !plan
    ? 0
    : me.plan!.id === 'team'
      ? me.plan!.period === 'yearly'
        ? Math.round(teamPriceCents(seats, 'year') / 12) / 100
        : teamPriceCents(seats, 'month') / 100
      : me.plan!.period === 'yearly'
        ? Math.round((Number(plan.priceYearlyUsd) / 12) * 100) / 100
        : Number(plan.priceMonthlyUsd);
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
      const code = errorCode(e);
      if (code === 'NO_PLAN') return void openUpgrade({ kind: 'top-up' });
      toast.show({ message: t(code === 'VALIDATION_FAILED' ? 'account.topUps.invalidAmount' : 'account.topUps.failed') });
    }
  }

  function download(inv: Invoice) {
    // Real API: the Stripe-hosted PDF (or the hosted invoice page).
    const href = inv.pdfUrl ?? inv.url;
    if (real) {
      if (href) window.open(href, '_blank', 'noopener');
      else toast.show({ message: t('account.settings.billing.pdf.missing') });
      return;
    }
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
                <FormattedMessage id="account.settings.billing.cancels" values={{ date: periodEnd }} />
              ) : (
                <FormattedMessage id="account.settings.billing.renews" values={{ price: money(price), date: periodEnd, credits: planCredits }} />
              )
            ) : (
              <FormattedMessage id="account.settings.billing.noPlan.text" />
            )}
          </span>
          <div className={styles.cardActions}>
            {plan ? (
              <Link to="/upgrade" className={cx(styles.btn, styles.btnPrimary, motion.press)}>
                <FormattedMessage id="account.settings.billing.changePlan" />
              </Link>
            ) : (
              // No plan yet: the upgrade modal in place.
              <button type="button" className={cx(styles.btn, styles.btnPrimary, motion.press)} onClick={() => void openUpgrade({ kind: 'plan' })}>
                <FormattedMessage id="account.settings.billing.pickPlan" />
              </button>
            )}
            {plan &&
              isOwner &&
              (me.cancelAtPeriodEnd ? (
                <button
                  type="button"
                  className={cx(styles.btn, motion.hover)}
                  disabled={cancel.isPending || portal}
                  onClick={async () => {
                    if (real) return void toPortal();
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
            <span className={cx(styles.splitPart, styles.splitPlan)} style={{ flexGrow: balance.plan }} />
            <span className={cx(styles.splitPart, styles.splitBought)} style={{ flexGrow: balance.purchased }} />
            <span className={cx(styles.splitPart, styles.splitRest)} style={{ flexGrow: rest }} />
          </div>
          <div className={styles.legend}>
            <span>
              <FormattedMessage id="account.settings.billing.planCredits" values={{ n: balance.plan, date: periodEnd }} />
            </span>
            <span>
              <FormattedMessage id="account.settings.billing.purchasedCredits" values={{ n: balance.purchased }} />
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
          disabled={(plan && !topUp) || buy.isPending}
          title={!plan ? t('account.topUps.membersOnly') : undefined}
          aria-busy={buy.isPending || undefined}
          // Top-ups are for members (D-007): without a plan the upgrade modal opens.
          onClick={() => (plan ? void purchase() : void openUpgrade({ kind: 'top-up' }))}
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
        hint={t(isOwner ? 'account.settings.billing.autoTopUp.hint' : 'account.settings.billing.ownerOnly', { below: me.autoTopUp.below, buy: auto.credits, price: money(auto.amountUsd) })}
        checked={me.autoTopUp.enabled}
        disabled={!isOwner}
        onChange={(v) =>
          // Without a plan, auto top-up opens the upgrade modal and turns on once the plan is active.
          v && !plan ? void openUpgrade({ kind: 'auto-top-up' }, { onResume: () => autoTopUp.mutate(true) }) : autoTopUp.mutate(v, {
            onSuccess: () => toast.show({ message: t(v ? 'account.settings.billing.autoOn' : 'account.settings.billing.autoOff') }),
            onError: (e) => (errorCode(e) === 'NO_PLAN' ? void openUpgrade({ kind: 'auto-top-up' }) : toast.show({ message: t('account.settings.billing.autoFailed') })),
          })
        }
      />
      <Row label={<FormattedMessage id="account.settings.billing.payment" />} hint={<FormattedMessage id="account.settings.billing.payment.hint" />}>
        <span className={cx(styles.rowValue, styles.rowValueWide)}>
          {me.paymentMethod ? (
            <span data-testid="card">
              <FormattedMessage id="account.settings.billing.card" values={{ brand: me.paymentMethod.brand, last4: me.paymentMethod.last4 }} />
              {/* The expiry comes from Stripe (real API); the design card line has none. */}
              {real && me.paymentMethod.expires && (
                <span className={styles.rowHint}>
                  {' · '}
                  <FormattedMessage id="account.settings.billing.cardExpires" values={{ date: me.paymentMethod.expires }} />
                </span>
              )}
            </span>
          ) : real ? (
            <FormattedMessage id="account.settings.billing.cardInPortal" />
          ) : (
            <FormattedMessage id="account.settings.billing.noCard" />
          )}
          {real ? (
            <button
              type="button"
              className={cx(styles.btn, motion.hover)}
              disabled={!isOwner || portal}
              aria-busy={portal || undefined}
              title={!isOwner ? t('account.settings.billing.ownerOnly') : undefined}
              onClick={() => void toPortal()}
            >
              <FormattedMessage id={portal ? 'account.settings.billing.portal.opening' : 'account.settings.billing.updateInPortal'} />
            </button>
          ) : (
            <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setCardOpen(true)}>
              <FormattedMessage id={me.paymentMethod ? 'account.settings.billing.update' : 'account.settings.billing.addCard'} />
            </button>
          )}
        </span>
      </Row>
      <h3 className={cx(styles.h3, styles.h3Invoices)}>
        <FormattedMessage id="account.settings.billing.invoices" />
      </h3>
      <div className={styles.invoices}>
        {invoices.length === 0 && (
          <p className={styles.rowHint} data-testid="no-invoices">
            <FormattedMessage id={isOwner ? 'account.settings.billing.invoices.empty' : 'account.settings.billing.invoices.ownerOnly'} />
          </p>
        )}
        {invoices.map((inv) => (
          <div key={inv.id} className={styles.invoice} data-invoice={inv.id}>
            <span className={styles.invoiceDate}>{date(inv.createdAt)}</span>
            <span>
              {inv.amountCents !== undefined ? (
                <FormattedMessage id="account.settings.billing.invoice.number" values={{ number: inv.number ?? inv.id, status: inv.status ?? '' }} />
              ) : inv.kind === 'plan' ? (
                <FormattedMessage id={`account.settings.billing.invoice.plan.${inv.period ?? 'monthly'}`} values={{ plan: PLANS[inv.planId ?? 'pro'].label }} />
              ) : (
                <FormattedMessage id="account.settings.billing.invoice.topUp" values={{ n: inv.credits ?? topUpFor(inv.amountUsd ?? 0, me.plan?.id ?? null).credits }} />
              )}
            </span>
            <span className={styles.invoiceAmount}>
              {inv.amountCents !== undefined
                ? intl.formatNumber(inv.amountCents / 100, { style: 'currency', currency: inv.currency ?? 'USD' })
                : money(inv.kind === 'plan' ? Number(PLANS[inv.planId ?? 'pro'].priceMonthlyUsd) : (inv.amountUsd ?? 0))}
            </span>
            <button type="button" className={cx(styles.invoicePdf, motion.hover)} aria-label={t('account.settings.billing.pdf.label', { id: inv.id })} onClick={() => download(inv)}>
              <FormattedMessage id="account.settings.billing.pdf" />
            </button>
          </div>
        ))}
      </div>
      {real && <LedgerList />}
      <CancelDialog
        open={cancelOpen}
        planLabel={plan?.label ?? ''}
        date={periodEnd}
        portal={real}
        pending={cancel.isPending || portal}
        onClose={() => setCancelOpen(false)}
        onConfirm={async () => {
          if (real) return void toPortal();
          await cancel.mutateAsync(true);
          setCancelOpen(false);
          toast.show({ message: t('account.settings.billing.canceled') });
        }}
      />
      <CardDialog open={cardOpen} onClose={() => setCardOpen(false)} />
    </>
  );
}

function CancelDialog(p: { open: boolean; planLabel: string; date: string; portal: boolean; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <Dialog
      open={p.open}
      onOpenChange={(o) => !o && p.onClose()}
      title={t('account.settings.cancel.title', { plan: p.planLabel })}
      description={`${t('account.settings.cancel.lead', { date: p.date })}${p.portal ? ` ${t('account.settings.cancel.portal')}` : ''}`}
      closeLabel={t('account.settings.close')}
    >
      <DialogActions>
        <button type="button" className={cx(styles.btn, motion.hover)} onClick={p.onClose}>
          <FormattedMessage id="account.settings.cancel.keep" />
        </button>
        <button type="button" className={cx(styles.btn, styles.btnDanger, motion.press)} disabled={p.pending} onClick={p.onConfirm}>
          <FormattedMessage id={p.pending ? 'account.settings.saving' : p.portal ? 'account.settings.cancel.toPortal' : 'account.settings.cancel.confirm'} />
        </button>
      </DialogActions>
    </Dialog>
  );
}

const LEDGER_KINDS = ['grant', 'purchase', 'hold', 'settle', 'release', 'refund', 'expire'] as const;

/** Credit history (`GET /api/billing/ledger`, newest first, 25 a page). */
function LedgerList() {
  const intl = useIntl();
  const date = useShortDate();
  const first = useLedger();
  const [more, setMore] = useState<LedgerLine[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const lines = [...(first.data?.lines ?? []), ...more];
  const next = cursor === undefined ? (first.data?.pageInfo.hasNextPage ? first.data.pageInfo.endCursor : null) : cursor;
  return (
    <section aria-labelledby="ledger-h" data-testid="ledger">
      <h3 id="ledger-h" className={cx(styles.h3, styles.h3Invoices)}>
        <FormattedMessage id="account.settings.billing.ledger" />
      </h3>
      <div className={styles.invoices}>
        {first.isSuccess && lines.length === 0 && (
          <p className={styles.rowHint}>
            <FormattedMessage id="account.settings.billing.ledger.empty" />
          </p>
        )}
        {lines.map((l) => (
          <div key={l.id} className={styles.invoice} data-ledger={l.kind}>
            <span className={styles.invoiceDate}>{date(l.createdAt)}</span>
            <span>
              <FormattedMessage id={`account.settings.billing.ledger.${(LEDGER_KINDS as readonly string[]).includes(l.kind) ? l.kind : 'other'}`} values={{ bucket: l.bucket }} />
            </span>
            <span className={styles.invoiceAmount}>{intl.formatNumber(l.amount, { signDisplay: 'exceptZero' })}</span>
            <span />
          </div>
        ))}
      </div>
      {next && (
        <button
          type="button"
          className={cx(styles.btn, motion.hover)}
          disabled={loading}
          aria-busy={loading || undefined}
          onClick={async () => {
            setLoading(true);
            try {
              const page = await fetchLedgerPage(next);
              setMore((m) => [...m, ...page.lines]);
              setCursor(page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null);
            } finally {
              setLoading(false);
            }
          }}
        >
          <FormattedMessage id="account.settings.billing.ledger.more" />
        </button>
      )}
    </section>
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
  const session = useSession();
  const seats = session.seats;
  const used = me.seats?.used ?? members.length;
  const isOwner = me.role === 'owner';
  const date = useShortDate();
  // D-013: personal plans → "Start Team"; Team without a free seat → "Add seats"; then the invite resumes
  // (with the email typed so far, also when the server refuses: TEAM_REQUIRED / SEATS_REQUIRED).
  /** Inviting without Team (D-013): the upgrade modal's Team variant; the invite resumes with the draft. */
  const startTeam = () => openUpgrade({ kind: 'team-invite', minSeats: used }, { onResume: () => setInviteOpen(true) });
  const [seatsFor, setSeatsFor] = useState<{ n: number; initial?: number; resume: boolean } | null>(null);
  const [draft, setDraft] = useState<{ email: string; role: Role } | null>(null);
  function invite() {
    if (!session.isTeam) return void startTeam();
    if (used >= seats) return setSeatsFor((s) => ({ n: (s?.n ?? 0) + 1, initial: used + 1, resume: true }));
    setInviteOpen(true);
  }
  function blocked(code: 'TEAM_REQUIRED' | 'SEATS_REQUIRED', needed: number | undefined, d: { email: string; role: Role }) {
    setDraft(d);
    setInviteOpen(false);
    if (code === 'TEAM_REQUIRED') startTeam();
    else setSeatsFor((s) => ({ n: (s?.n ?? 0) + 1, initial: Math.max(needed ?? used + 1, used + 1), resume: true }));
  }
  // Back from a Team checkout started here (`/settings/team?resume=invite`): continue the invite.
  const search = useSearch({ strict: false }) as { resume?: string };
  const navigate = useNavigate();
  useEffect(() => {
    if (search.resume !== 'invite' || !session.isTeam) return;
    setInviteOpen(true);
    void navigate({ to: '/settings/$section', params: { section: 'team' }, search: {}, replace: true });
  }, [search.resume, session.isTeam, navigate]);
  return (
    <>
      <Head
        id="account.settings.section.team"
        sub={<FormattedMessage id={session.isTeam || members.length > 1 ? 'account.settings.team.sub' : 'account.settings.team.sub.personal'} values={{ workspace: me.workspace.name }} />}
      />
      {members.map((m) => {
        const self = m.isYou ?? m.email === me.user.email;
        return (
          <div key={m.id} className={styles.member} data-member={m.id}>
            <MemberAvatar name={m.name} image={self ? (me.user.image ?? m.image) : m.image} />
            <span className={styles.memberText}>
              <span className={styles.memberName}>
                {m.name}
                {m.invited && (
                  <span className={styles.invited}>
                    <FormattedMessage id="account.settings.team.invited" />
                  </span>
                )}
              </span>
              <span className={styles.memberEmail}>
                {m.email}
                {m.invited && m.expiresAt ? (
                  <>
                    {' · '}
                    <FormattedMessage id="account.settings.team.expires" values={{ date: date(m.expiresAt) }} />
                  </>
                ) : null}
              </span>
            </span>
            <button
              type="button"
              className={cx(styles.limit, styles.limitBtn, motion.hover)}
              disabled={m.role === 'viewer' || !isOwner || (!isMockApi() && m.invited)}
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
            {isOwner && !(m.invited && !isMockApi()) ? (
              <SelectMenu<Role>
                label={t('account.settings.team.role', { name: m.name })}
                value={m.role}
                options={ROLES.map((r) => ({ value: r, label: t(`account.settings.team.role.${r}`) }))}
                onChange={(r) =>
                  patch.mutate(
                    { id: m.id, patch: { role: r } },
                    {
                      onSuccess: () => toast.show({ message: t('account.settings.team.roleChanged', { name: m.name, role: t(`account.settings.team.role.${r}`) }) }),
                      onError: (e) => toast.show({ message: t(errorCode(e) === 'CONFLICT' ? 'account.settings.team.lastOwner' : 'account.settings.team.failed') }),
                    },
                  )
                }
              />
            ) : (
              <span className={styles.rowHint} data-testid="member-role">
                <FormattedMessage id={`account.settings.team.role.${m.role}`} />
              </span>
            )}
            <button
              type="button"
              className={cx(styles.iconBtn, motion.hover)}
              disabled={self || !isOwner}
              title={self ? t('account.settings.team.remove.self') : !isOwner ? t('account.settings.team.ownerOnly') : undefined}
              aria-label={t(m.invited && !isMockApi() ? 'account.settings.team.revoke' : 'account.settings.team.remove', { name: m.name })}
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
          disabled={!isOwner}
          title={!isOwner ? t('account.settings.team.ownerOnly') : session.isTeam && used >= seats ? t('account.settings.team.seatsFull', { n: seats }) : undefined}
          onClick={invite}
        >
          <FormattedMessage id="account.settings.team.invite" />
        </button>
        <span className={styles.rowHint} data-testid="team-seats">
          {session.isTeam ? (
            <FormattedMessage id="account.settings.team.seatsOf" values={{ used, n: seats }} />
          ) : (
            <FormattedMessage id="account.settings.team.membersOnly" values={{ n: used }} />
          )}
        </span>
        {session.isTeam && isOwner && (
          <button type="button" className={cx(styles.btn, motion.hover)} onClick={() => setSeatsFor((s) => ({ n: (s?.n ?? 0) + 1, resume: false }))}>
            <FormattedMessage id="account.settings.team.changeSeats" />
          </button>
        )}
      </div>
      <InviteDialog
        key={draft ? `draft-${draft.email}` : 'invite'}
        open={inviteOpen}
        initial={draft}
        onClose={() => {
          setInviteOpen(false);
          setDraft(null);
        }}
        onBlocked={blocked}
      />
      {seatsFor && (
        <SeatsDialog
          key={`seats-${seatsFor.n}`}
          open
          used={used}
          initial={seatsFor.initial}
          onClose={() => setSeatsFor(null)}
          onDone={(n) => {
            if (seatsFor.resume && n > used) setInviteOpen(true);
          }}
        />
      )}
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
              remove.mutate(
                { id: m.id, invited: m.invited },
                {
                  onSuccess: () => {
                    setRemoveFor(null);
                    toast.show({ message: t(m.invited && !isMockApi() ? 'account.settings.team.revoked' : 'account.settings.team.removed', { name: m.name }) });
                  },
                  onError: (e) => toast.show({ message: t(errorCode(e) === 'CONFLICT' ? 'account.settings.team.lastOwner' : 'account.settings.team.failed') }),
                },
              );
            }}
          >
            <FormattedMessage id="account.settings.team.remove.confirm" />
          </button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function InviteDialog({
  open,
  onClose,
  initial,
  onBlocked,
}: {
  open: boolean;
  onClose: () => void;
  initial?: { email: string; role: Role } | null;
  /** The server needs Team or more seats first; the caller opens that dialog and resumes with the draft. */
  onBlocked?: (code: 'TEAM_REQUIRED' | 'SEATS_REQUIRED', needed: number | undefined, draft: { email: string; role: Role }) => void;
}) {
  const t = useT();
  const toast = useToast();
  const invite = useInviteMember();
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? 'editor');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const limitId = useId();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError(t('account.settings.account.error.email'));
    const n = limit.trim() ? Number(limit) : null;
    try {
      await invite.mutateAsync({ email: email.trim(), role, monthlyCreditLimit: role === 'viewer' ? null : n });
    } catch (err) {
      const code = errorCode(err);
      if ((code === 'TEAM_REQUIRED' || code === 'SEATS_REQUIRED') && onBlocked) {
        const needed = isApiError(err) ? (err.data as { needed?: number }).needed : undefined;
        return onBlocked(code, needed, { email: email.trim(), role });
      }
      return setError(t(code === 'CONFLICT' ? 'account.settings.team.alreadyMember' : code === 'VALIDATION' || code === 'VALIDATION_FAILED' ? 'account.settings.account.error.email' : 'account.settings.team.failed'));
    }
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

/** A member's photo filling the round avatar; the initial when there is none or it fails to load. */
function MemberAvatar({ name, image }: { name: string; image?: string | null }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [image]);
  return (
    <span className={styles.avatarSm} aria-hidden="true">
      {image && !broken ? (
        <img src={image} alt="" className={styles.avatarImg} draggable={false} referrerPolicy="no-referrer" data-testid="member-avatar-img" onError={() => setBroken(true)} />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
