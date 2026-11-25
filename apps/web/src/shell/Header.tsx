import { IconButton, Popover, Tooltip } from '@rolling/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { FormattedMessage, FormattedNumber, useIntl } from 'react-intl';
import styles from './Header.module.css';
import { Icon, LogoMark } from './icons';
import { isNavItemActive, navItems } from './nav';
import { placeholderAccount } from './placeholder';
import { SettingsPopoverContent } from './SettingsPopover';
import { NARROW_NAV_QUERY, useMediaQuery } from './useMediaQuery';

export function Header() {
  const intl = useIntl();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const narrow = useMediaQuery(NARROW_NAV_QUERY);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const account = placeholderAccount;

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

      <nav aria-label={intl.formatMessage({ id: 'nav.label' })} className={styles.nav} data-testid="main-nav">
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
        <button
          type="button"
          className={styles.credits}
          aria-label={intl.formatMessage({ id: 'header.credits.label' }, { balance: account.creditBalance })}
        >
          <Icon name="coin" size={15} className={styles.creditsCoin} />
          <span className={styles.creditsValue}>
            <FormattedNumber value={account.creditBalance} />
          </span>
          <span className={styles.creditsPlus}>
            <Icon name="plus" size={13} strokeWidth={2.2} />
          </span>
        </button>
        <Link to="/upgrade" className={styles.upgrade}>
          <FormattedMessage id="header.upgrade" />
        </Link>
        <Popover
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          label={intl.formatMessage({ id: 'settingsPopover.title' })}
          align="end"
          offset={5}
          alignOffset={46}
          trigger={(p) => (
            <IconButton {...p} label={intl.formatMessage({ id: 'header.settings' })} icon={<Icon name="gear" size={17} />} />
          )}
        >
          <SettingsPopoverContent onClose={() => setSettingsOpen(false)} />
        </Popover>
        <button type="button" className={styles.avatar} aria-label={intl.formatMessage({ id: 'header.account' })}>
          <span aria-hidden="true">{account.initial}</span>
          {account.plan === 'pro' ? (
            <span className={styles.proBadge} aria-hidden="true">
              <FormattedMessage id="header.proBadge" />
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
