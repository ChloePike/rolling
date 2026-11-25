import { IconButton, Popover, Tooltip, useIndicator, useToast } from '@rolling/ui';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import { AccountMenuContent } from './AccountMenu';
import { CreditsPopoverContent } from './CreditsPopover';
import styles from './Header.module.css';
import { Icon, LogoMark } from './icons';
import { isNavItemActive, navItems } from './nav';
import { signOut, useCredits, useSession } from '@/lib/session';
import { HelpDialog } from './HelpDialog';
import { placeholderAccount } from './placeholder';
import { SettingsPopoverContent } from './SettingsPopover';
import { NARROW_NAV_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * Shift of the credits popover past the credits button's right edge so it sits
 * at `right:68px` like Main.dc.html (measured at 1440 wide, see header.spec.ts).
 */
const CREDITS_ALIGN_OFFSET = 129;

/**
 * Shared header (Main.dc.html): logo, nav pill with a sliding active pill,
 * credits popover, Upgrade, settings popover and account menu. One popover at a time.
 */
export function Header() {
  const intl = useIntl();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const narrow = useMediaQuery(NARROW_NAV_QUERY);
  const [open, setOpen] = useState<'credits' | 'settings' | 'account' | null>(null);
  const toggle = (which: 'credits' | 'settings' | 'account') => (next: boolean) => setOpen(next ? which : (o) => (o === which ? null : o));
  const navRef = useRef<HTMLElement>(null);
  // The active pill slides between items (200ms, standard curve) on navigation.
  const pill = useIndicator(navRef, `${pathname}-${narrow}`, '[aria-current="page"]');
  const account = placeholderAccount;
  const navigate = useNavigate();
  const toast = useToast();
  const [help, setHelp] = useState(false);
  const { planId } = useSession();
  const logout = () => {
    void signOut().then(() => {
      void navigate({ to: '/login' });
      toast.show({ message: intl.formatMessage({ id: 'shell.account.loggedOut' }) });
    });
  };
  const { available } = useCredits();

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

      <div className={styles.actions}>
        <Popover
          open={open === 'credits'}
          onOpenChange={toggle('credits')}
          label={intl.formatMessage({ id: 'shell.credits.title' })}
          align="end"
          offset={5}
          alignOffset={CREDITS_ALIGN_OFFSET}
          className={styles.creditsLayer}
          trigger={(p) => (
            <button
              {...p}
              type="button"
              className={styles.credits}
              aria-label={intl.formatMessage({ id: 'header.credits.label' }, { balance: available })}
            >
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
          <CreditsPopoverContent onNavigate={() => setOpen(null)} />
        </Popover>
        <Link to="/upgrade" className={styles.upgrade}>
          <FormattedMessage id="header.upgrade" />
        </Link>
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
          <SettingsPopoverContent onClose={() => setOpen(null)} />
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
              <span aria-hidden="true">{account.initial}</span>
              {planId === 'pro' ? (
                <span className={styles.proBadge} aria-hidden="true">
                  <FormattedMessage id="header.proBadge" />
                </span>
              ) : null}
            </button>
          )}
        >
          <AccountMenuContent onClose={() => setOpen(null)} onHelp={() => setHelp(true)} onLogout={logout} />
        </Popover>
      </div>
      <HelpDialog open={help} onOpenChange={setHelp} />
    </header>
  );
}
