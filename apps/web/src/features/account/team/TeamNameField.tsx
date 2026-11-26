import { useId, useState } from 'react';
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl';
import { useSession } from '@/lib/session';
import styles from './team.module.css';

/** Longest workspace name the API takes (`WORKSPACE_NAME_MAX`). */
export const TEAM_NAME_MAX = 60;

/** “{name}’s team” from the owner's name, else their email's local part, else “Team” (the API default too). */
export function defaultTeamName(intl: IntlShape, user: { name?: string | null; email?: string | null } | null): string {
  const name = user?.name?.trim() || user?.email?.split('@')[0]?.trim() || '';
  return name ? intl.formatMessage({ id: 'account.team.name.default' }, { name }).slice(0, TEAM_NAME_MAX) : intl.formatMessage({ id: 'account.team.name.fallback' });
}

/** The Team flow's name for the workspace; starts at the default, which is also what an empty field sends. */
export function useTeamName(): [string, (v: string) => void, string] {
  const intl = useIntl();
  const session = useSession();
  const fallback = defaultTeamName(intl, session.user);
  const [value, setValue] = useState(fallback);
  return [value, setValue, value.trim() || fallback];
}

export function TeamNameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className={styles.nameField}>
      <label htmlFor={id} className={styles.seatsLabel}>
        <FormattedMessage id="account.team.name.label" />
      </label>
      <input id={id} className={styles.nameInput} value={value} maxLength={TEAM_NAME_MAX} autoComplete="organization" onChange={(e) => onChange(e.target.value)} data-testid="team-name" />
      <span className={styles.seatsHint}>
        <FormattedMessage id="account.team.name.hint" />
      </span>
    </div>
  );
}
