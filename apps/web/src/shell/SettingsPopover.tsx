import { IconButton } from '@rolling/ui';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Icon, type IconName } from './icons';
import { placeholderAccount } from './placeholder';
import styles from './SettingsPopover.module.css';

type CreationMode = 'simple' | 'advanced';
/** Local stand-in for `prefs.creationMode` until M1 wires prefs. */
const MODE_KEY = 'rolling.creationMode';

const modes: ReadonlyArray<{ value: CreationMode; icon: IconName }> = [
  { value: 'simple', icon: 'chat' },
  { value: 'advanced', icon: 'sliders' },
];

function readMode(): CreationMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

export function SettingsPopoverContent({ onClose }: { onClose: () => void }) {
  const intl = useIntl();
  const [mode, setMode] = useState<CreationMode>(readMode);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const account = placeholderAccount;

  const pick = (value: CreationMode) => {
    setMode(value);
    try {
      window.localStorage.setItem(MODE_KEY, value);
    } catch {
      /* Storage unavailable; keep the in-memory choice. */
    }
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const next = (i + 1) % modes.length;
    const m = modes[next];
    if (m) {
      pick(m.value);
      refs.current[next]?.focus();
    }
  };

  const languageName =
    new Intl.DisplayNames([intl.locale], { type: 'language' }).of(intl.locale) ?? intl.locale;

  const rows: Array<{ id: string; value: ReactNode }> = [
    { id: 'settingsPopover.language', value: languageName },
    { id: 'settingsPopover.currency', value: account.currency },
    { id: 'settingsPopover.aspectRatio', value: account.defaultAspectRatio },
    {
      id: 'settingsPopover.notify',
      value: <FormattedMessage id={account.notifyWhenDone ? 'settingsPopover.notify.on' : 'settingsPopover.notify.off'} />,
    },
  ];

  return (
    <div className={styles.panel}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>
          <FormattedMessage id="settingsPopover.title" />
        </h2>
        <IconButton
          size={28}
          variant="ghost"
          label={intl.formatMessage({ id: 'settingsPopover.close' })}
          icon={<Icon name="close" size={16} />}
          onClick={onClose}
        />
      </div>
      <div id="creation-mode-label" className={styles.sectionLabel}>
        <FormattedMessage id="settingsPopover.creationMode" />
      </div>
      <div role="radiogroup" aria-labelledby="creation-mode-label" className={styles.modes}>
        {modes.map((m, i) => {
          const on = mode === m.value;
          return (
            <button
              key={m.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={styles.mode}
              onClick={() => pick(m.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className={styles.modeIcon}>
                <Icon name={m.icon} size={15} />
              </span>
              <span className={styles.modeText}>
                <span className={styles.modeName}>
                  <FormattedMessage
                    id="settingsPopover.creationMode.option"
                    values={{
                      label: intl.formatMessage({ id: `settingsPopover.creationMode.${m.value}` }),
                      sub: intl.formatMessage({ id: `settingsPopover.creationMode.${m.value}.sub` }),
                      muted: (chunks) => <span className={styles.muted}>{chunks}</span>,
                    }}
                  />
                </span>
                <span className={styles.modeDesc}>
                  <FormattedMessage id={`settingsPopover.creationMode.${m.value}.desc`} />
                </span>
              </span>
              <span className={styles.radio} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className={styles.divider} role="presentation" />
      {rows.map((row) => (
        <div key={row.id} className={styles.row}>
          <span className={styles.rowLabel}>
            <FormattedMessage id={row.id} />
          </span>
          <span className={styles.rowValue}>
            {row.value} <span aria-hidden="true">›</span>
          </span>
        </div>
      ))}
    </div>
  );
}
