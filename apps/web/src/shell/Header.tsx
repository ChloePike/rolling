import { IconButton, Popover, Skeleton, Tooltip, useIndicator, useToast } from '@rolling/ui';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Suspense, useEffect, useRef, useState } from 'react';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import styles from './Header.module.css';
import { Icon, LogoMark } from './icons';
import { isNavItemActive, navItems } from './nav';
import { signOut, useCredits, useSession } from '@/lib/session';
import { AvatarFace } from './AvatarFace';
import { TrialChip } from './Trial';
import { NARROW_NAV_QUERY, useMediaQuery } from './useMediaQuery';
import { lazyComponent } from '@/lib/lazy';

/*
 * The header's popovers and the Help dialog load on demand (bundle splitting): fetched
 * right after the signed-in header renders (not part of the page's first-load JS), and
 * again on pointer or focus in the header's actions, so they are ready for the first click.
 */
const CreditsPopoverContent = lazyComponent(() => import('./CreditsPopover'), (m) => m.CreditsPopoverContent);
const SettingsPopoverContent = lazyComponent(() => import('./SettingsPopover'), (m) => m.SettingsPopoverContent);
const AccountMenuContent = lazyComponent(() => import('./AccountMenu'), (m) => m.AccountMenuContent);
const HelpDialog = lazyComponent(() => import('./HelpDialog'), (m) => m.HelpDialog);
const LAYERS = [CreditsPopoverContent, SettingsPopoverContent, AccountMenuContent, HelpDialog];
const LAYER_OF = { credits: CreditsPopoverContent, settings: SettingsPopoverContent, account: AccountMenuContent };
const preloadLayers = () => LAYERS.forEach((c) => void c.preload());

/**
 * Shift of the credits popover past the credits button's right edge so it sits
 * at `right:68px` like Main.dc.html (measured at 1440 wide, see header.spec.ts).
 * Measured when it opens (`creditsAlignOffset`), since what sits right of the button
 * (Upgrade, whose width follows the language, or nothing for Pro and Team) varies;
 * this is the fallback before a measurement.
 */
const CREDITS_ALIGN_OFFSET = 129;
const CREDITS_RIGHT_INSET = 68;

/** The offset that puts the credits popover's right edge `CREDITS_RIGHT_INSET` from the viewport's. */
function creditsAlignOffset(): number {
  const button = document.querySelector<HTMLElement>('[data-credits-trigger]');
  if (!button) return CREDITS_ALIGN_OFFSET;
  return Math.max(0, Math.round(document.documentElement.clientWidth - CREDITS_RIGHT_INSET - button.getBoundingClientRect().right));
}

/**
 * Shared header (Main.dc.html): logo, nav pill with a sliding active pill,
 * credits popover, Upgrade, settings popover and account menu. One popover at a time.
 */
export function Header() {
  const intl = useIntl();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const narrow = useMediaQuery(NARROW_NAV_QUERY);
  const [open, setOpen] = useState<'credits' | 'settings' | 'account' | null>(null);
  const [creditsOffset, setCreditsOffset] = useState(CREDITS_ALIGN_OFFSET);
  const toggle = (which: 'credits' | 'settings' | 'account') => (next: boolean) => {
    if (next && which === 'credits') setCreditsOffset(creditsAlignOffset());
    if (!next) return setOpen((o) => (o === which ? null : o));
    // Opens once its chunk is in (normally preloaded), so it renders and is placed with its content.
    void LAYER_OF[which].preload().then(() => setOpen(which));
  };
  const navRef = useRef<HTMLElement>(null);
  // The active pill slides between items (200ms, standard curve) on navigation.
  const pill = useIndicator(navRef, `${pathname}-${narrow}`, '[aria-current="page"]');
  const navigate = useNavigate();
  const toast = useToast();
  const [help, setHelp] = useState(false);
  const [helpMounted, setHelpMounted] = useState(false);
  if (help && !helpMounted) setHelpMounted(true);
  const session = useSession();
  const { planId } = session;
  const logout = () => {
    void signOut()
      .catch(() => undefined)
      .then(() => {
        void navigate({ to: '/login' });
        toast.show({ message: intl.formatMessage({ id: 'shell.account.loggedOut' }) });
      });
  };
  const { available } = useCredits();
  // Public pages (plans) are open to signed-out visitors: log in instead of credits and account.
  const signedOut = session.status === 'signedOut';
  const loading = session.status === 'loading';
  useEffect(() => {
    if (!signedOut && !loading) preloadLayers();
  }, [signedOut, loading]);

  return (
    <header className={styles.header} data-testid="app-header">
      <div className={styles.brand}>
        <Link to="/" className={styles.brandLink} aria-label={intl.formatMessage({ id: 'header.home' })}>
          <LogoMark size={30} />
          <span className={styles.wordmark} aria-hidden="true">
            <FormattedMessage id="app.name" />
          </span>
        </Link>
      </div>

      <nav ref={navRef} aria-label={intl.formatMessage({ id: 'nav.label' })} className={styles.nav} data-testid="main-nav">
        <span className={styles.navPill} style={pill} aria-hidden="true" data-testid="nav-pill" />
        {navItems.map((item) => {
          const active = isNavItemActive(item, pathname);
          const label = intl.formatMessage({ id: item.messageId });
          return (
            <Tooltip key={item.id} content={label} enabled={narrow}>
              {() => (
                <Link
                  to={item.to}
                  params={item.params as never}
                  className={styles.navItem}
                  aria-current={active ? 'page' : undefined}
                  data-nav={item.id}
                >
                  <Icon name={item.icon} size={16} />
                  <span className={styles.navLabel}>{label}</span>
                </Link>
              )}
            </Tooltip>
          );
        })}
      </nav>

      <div className={styles.actions} data-session={session.status} onPointerEnter={preloadLayers} onFocus={preloadLayers}>
        {signedOut ? (
          <>
            <Link to="/login" search={{ redirect: pathname }} className={styles.upgrade} data-testid="header-login">
              <FormattedMessage id="header.login" />
            </Link>
          </>
        ) : loading ? (
          // `/api/me` in flight: placeholders the size of credits, Upgrade, settings and avatar (never a 0 or a sample balance).
          <>
            <span className="rl-visually-hidden" role="status" data-testid="header-loading">
              {intl.formatMessage({ id: 'shell.load.loading' })}
            </span>
            <Skeleton width={104} height={34} round />
            <Skeleton width={86} height={34} round />
            <Skeleton width={32} height={32} round />
            <Skeleton width={34} height={34} round />
          </>
        ) : (
          <>
            <Popover
              open={open === 'credits'}
              onOpenChange={toggle('credits')}
              label={intl.formatMessage({ id: 'shell.credits.title' })}
              align="end"
              offset={5}
              alignOffset={creditsOffset}
              className={styles.creditsLayer}
              trigger={(p) => (
                <button
                  {...p}
                  type="button"
                  className={styles.credits}
                  data-credits-trigger=""
                  aria-label={intl.formatMessage({ id: 'header.credits.label' }, { balance: available })}
                >
                  <TrialChip />
                  <Icon name="coin" size={15} className={styles.creditsCoin} />
                  <span className={styles.creditsValue}>
                    <FormattedNumber value={available} />
                  </span>
                  <span className={styles.creditsPlus}>
                    <Icon name="plus" size={13} strokeWidth={2.2} />
                  </span>
                </button>
              )}
            >
              <Suspense fallback={null}>
                <CreditsPopoverContent onNavigate={() => setOpen(null)} />
              </Suspense>
            </Popover>
            {/* Upgrade only when there is a higher plan to move to: none for Pro or Team. */}
            {planId !== 'pro' && planId !== 'team' ? (
              <Link to="/upgrade" className={styles.upgrade}>
                <FormattedMessage id="header.upgrade" />
              </Link>
            ) : null}
            <Popover
              open={open === 'settings'}
              onOpenChange={toggle('settings')}
              label={intl.formatMessage({ id: 'settingsPopover.title' })}
              align="end"
              offset={5}
              alignOffset={46}
              trigger={(p) => (
                <IconButton {...p} label={intl.formatMessage({ id: 'header.settings' })} icon={<Icon name="gear" size={17} />} />
              )}
            >
              <Suspense fallback={null}>
                <SettingsPopoverContent onClose={() => setOpen(null)} />
              </Suspense>
            </Popover>
            <Popover
              open={open === 'account'}
              onOpenChange={toggle('account')}
              label={intl.formatMessage({ id: 'shell.account.menu' })}
              role="menu"
              align="end"
              offset={5}
              alignOffset={4}
              autoFocus={false}
              className={styles.accountLayer}
              trigger={(p) => (
                <button {...p} type="button" className={styles.avatar} aria-label={intl.formatMessage({ id: 'header.account' })}>
                  <AvatarFace session={session} className={styles.avatarImg} />
                  {planId === 'pro' || planId === 'team' ? (
                    <span className={styles.proBadge} aria-hidden="true" data-badge={planId}>
                      <FormattedMessage id={planId === 'team' ? 'header.teamBadge' : 'header.proBadge'} />
                    </span>
                  ) : null}
                </button>
              )}
            >
              <Suspense fallback={null}>
                <AccountMenuContent onClose={() => setOpen(null)} onHelp={() => void HelpDialog.preload().then(() => setHelp(true))} onLogout={logout} />
              </Suspense>
            </Popover>
          </>
        )}
      </div>
      {/* Mounted once opened, so it can animate out. */}
      {help || helpMounted ? (
        <Suspense fallback={null}>
          <HelpDialog open={help} onOpenChange={setHelp} />
        </Suspense>
      ) : null}
    </header>
  );
}
