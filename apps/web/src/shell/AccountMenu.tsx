import { cx } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import styles from './AccountMenu.module.css';
import { PLANS } from '@rolling/core/pricing/config';
import { useMembers } from '@/features/account/api';
import { setActiveWorkspace, useSession } from '@/lib/session';
import { accountHandle, accountInitial, accountName } from './account';
import { AvatarFace } from './AvatarFace';

const P = {
  profile: 'M18 20a6 6 0 0 0-12 0 M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  plans:
    'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z M5 21h14',
  billing: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8 M12 17.5v-11',
  members: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  help: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  check: 'M20 6 9 17l-5-5',
};

function I({ d, size = 16, sw = 2 }: { d: string; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/**
 * Account menu under the header avatar (Main.dc.html): profile line, workspace
 * switch, links (profile, settings, plans and billing, billing and invoices,
 * members, help) and log out. Arrow keys move between items.
 */
export function AccountMenuContent({ onClose, onLogout, onHelp }: { onClose: () => void; onLogout?: () => void; onHelp?: () => void }) {
  const intl = useIntl();
  // Workspaces come from `GET /api/me`; switching sets `x-workspace-id` and refetches (lib/session).
  const session = useSession();
  const workspace = session.workspace?.id ?? null;
  const setWorkspace = setActiveWorkspace;
  const rootRef = useRef<HTMLDivElement>(null);
  const { planId, plan } = session;
  const planLabel = planId ? (plan?.label ?? PLANS[planId].label) : null;
  const members = useMembers();
  const memberCount = members.data ? members.data.filter((m) => !m.invited).length : null;
  const workspaces = session.workspaces.map((w) => ({
    ...w,
    mark: accountInitial({ user: { id: w.id, email: null, name: w.name, image: null } }),
    tone: w.kind === 'personal' ? 'var(--c-tone-graphite)' : 'var(--c-tone-fern)',
  }));

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const links = [
    { id: 'profile', to: '/u/$handle', params: { handle: accountHandle(session) }, d: P.profile },
    { id: 'settings', to: '/settings/$section', params: { section: 'account' }, d: P.settings },
    { id: 'plans', to: '/upgrade', d: P.plans, note: planLabel ?? undefined },
    { id: 'billing', to: '/settings/$section', params: { section: 'billing' }, d: P.billing },
    { id: 'members', to: '/settings/$section', params: { section: 'team' }, d: P.members, note: memberCount !== null ? intl.formatNumber(memberCount) : undefined },
  ] as const;

  return (
    <div ref={rootRef} className={styles.menu} onKeyDown={onKeyDown}>
      <div className={styles.who}>
        <span className={styles.bigAvatar} aria-hidden="true">
          <AvatarFace session={session} className={styles.avatarImg} />
        </span>
        <span className={styles.whoText}>
          <span className={styles.whoName}>{accountName(session)}</span>
          <span className={styles.whoPlan} data-testid="account-plan-line">
            {planLabel && plan?.currentPeriodEnd ? (
              <FormattedMessage
                id={plan.cancelAtPeriodEnd ? 'shell.account.planEnds' : 'shell.account.planLine'}
                values={{ plan: planLabel, date: intl.formatDate(plan.currentPeriodEnd, { month: 'short', day: 'numeric' }) }}
              />
            ) : planLabel ? (
              <FormattedMessage id="shell.account.planOnly" values={{ plan: planLabel }} />
            ) : (
              <FormattedMessage id="shell.account.noPlan" />
            )}
          </span>
        </span>
      </div>
      <div className={styles.section} role="presentation">
        <FormattedMessage id="shell.account.workspace" />
      </div>
      <div role="group" aria-label={intl.formatMessage({ id: 'shell.account.workspace' })} className={styles.group}>
        {workspaces.map((w) => {
          const on = w.id === workspace;
          return (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              tabIndex={-1}
              className={styles.space}
              onClick={() => setWorkspace(w.id)}
            >
              <span className={styles.spaceMark} style={{ background: w.tone }}>
                {w.mark}
              </span>
              <span className={styles.spaceText}>
                <span className={styles.spaceName}>{w.name}</span>
                <span className={styles.spaceMeta}>
                  {w.kind === 'personal' ? (
                    <FormattedMessage id="shell.account.personal.meta" />
                  ) : on && memberCount !== null ? (
                    <FormattedMessage id="shell.account.team.meta" values={{ members: memberCount }} />
                  ) : (
                    <FormattedMessage id="shell.account.team.metaShort" />
                  )}
                </span>
              </span>
              {on ? <I d={P.check} size={15} sw={2.4} /> : null}
            </button>
          );
        })}
      </div>
      <div className={styles.divider} role="separator" />
      {links.map((l) => (
          <Link
            key={l.id}
            to={l.to}
            params={'params' in l ? (l.params as never) : undefined}
            role="menuitem"
            tabIndex={-1}
            className={styles.item}
            onClick={onClose}
          >
            <I d={l.d} />
            <span className={styles.itemLabel}>
              <FormattedMessage id={`shell.account.${l.id}`} />
            </span>
            {'note' in l && l.note ? <span className={styles.note}>{l.note}</span> : null}
          </Link>
      ))}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="dialog"
        className={styles.item}
        onClick={() => {
          onClose();
          onHelp?.();
        }}
      >
        <I d={P.help} />
        <span className={styles.itemLabel}>
          <FormattedMessage id="shell.account.help" />
        </span>
      </button>
      <div className={styles.divider} role="separator" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={cx(styles.item, styles.logout)}
        onClick={() => {
          onLogout?.();
          onClose();
        }}
      >
        <I d={P.logout} />
        <FormattedMessage id="shell.account.logout" />
      </button>
    </div>
  );
}
