import { IconButton, OptionList, type OptionListItem } from '@rolling/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  ASPECT_RATIO_OPTIONS,
  LANGUAGE_OPTIONS,
  languageOption,
  setCreationMode,
  setPref,
  setPrefs,
  THEME_OPTIONS,
  usePrefs,
  type CreationMode,
} from '@/lib/prefs';
import { Icon, type IconName } from './icons';
import styles from './SettingsPopover.module.css';

const modes: ReadonlyArray<{ value: CreationMode; icon: IconName }> = [
  { value: 'simple', icon: 'chat' },
  { value: 'advanced', icon: 'sliders' },
];

// No currency row: prices are shown and charged in USD only (D-019).
type Sub = 'language' | 'aspectRatio' | 'notify' | 'theme';
const SUBS: readonly Sub[] = ['language', 'aspectRatio', 'notify', 'theme'];

/**
 * Header settings popover (MainSettings.dc.html): creation mode, then
 * Language, Default aspect ratio, Notify when done and Theme (D-010); no
 * currency (USD only, D-019).
 * Each `›` row opens its option list in place; picking one saves it to
 * lib/prefs (shared with Settings → Preferences) and returns to the rows.
 * Escape or ‹ goes back one level; Escape on the rows closes the popover.
 */
export function SettingsPopoverContent({ onClose }: { onClose: () => void }) {
  const intl = useIntl();
  const prefs = usePrefs();
  const mode = prefs.creationMode;
  const [sub, setSub] = useState<Sub | null>(null);
  const lastSub = useRef<Sub | null>(null);
  const modeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef(new Map<Sub, HTMLButtonElement>());
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);

  // Back on the rows: focus the row whose list was open.
  useEffect(() => {
    if (sub === null && lastSub.current) rowRefs.current.get(lastSub.current)?.focus();
  }, [sub]);

  const open = (s: Sub) => {
    lastSub.current = s;
    setSub(s);
  };
  const back = () => setSub(null);

  const pick = (value: CreationMode) => setCreationMode(value);
  const onModeKeyDown = (e: KeyboardEvent, i: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const next = (i + 1) % modes.length;
    const m = modes[next];
    if (m) {
      pick(m.value);
      modeRefs.current[next]?.focus();
    }
  };

  const current = languageOption(prefs.language ?? intl.locale) ?? LANGUAGE_OPTIONS[0]!;
  const values: Record<Sub, string> = {
    language: current.name,
    aspectRatio: prefs.defaultAspectRatio,
    notify: t(prefs.notifyWhenDone ? 'settingsPopover.notify.on' : 'settingsPopover.notify.off'),
    theme: t(`settingsPopover.theme.${prefs.theme}`),
  };

  const lists: Record<Sub, { value: string; options: OptionListItem[]; onSelect: (v: string) => void }> = {
    language: {
      value: current.tag,
      options: LANGUAGE_OPTIONS.map((o) => ({
        value: o.tag,
        label: o.name,
        lang: o.tag,
        hint: o.translated ? undefined : t('settingsPopover.language.notTranslated'),
      })),
      onSelect: (tag) => setPrefs({ language: tag }),
    },
    aspectRatio: {
      value: prefs.defaultAspectRatio,
      options: ASPECT_RATIO_OPTIONS.map((r) => ({ value: r, label: r, hint: t(`settingsPopover.aspectRatio.${r.replace(':', 'x')}`) })),
      onSelect: (r) => setPref('defaultAspectRatio', r as (typeof ASPECT_RATIO_OPTIONS)[number]),
    },
    notify: {
      value: prefs.notifyWhenDone ? 'on' : 'off',
      options: [
        { value: 'on', label: t('settingsPopover.notify.on'), hint: t('settingsPopover.notify.on.hint') },
        { value: 'off', label: t('settingsPopover.notify.off') },
      ],
      onSelect: (v) => setPref('notifyWhenDone', v === 'on'),
    },
    theme: {
      value: prefs.theme,
      options: THEME_OPTIONS.map((th) => ({ value: th, label: t(`settingsPopover.theme.${th}.option`) })),
      onSelect: (v) => setPref('theme', v as (typeof THEME_OPTIONS)[number]),
    },
  };

  if (sub) {
    const list = lists[sub];
    return (
      <div className={styles.panel} data-sub={sub}>
        <div className={styles.titleRow}>
          <button type="button" className={styles.back} onClick={back} aria-label={t('settingsPopover.back')}>
            <Icon name="back" size={16} strokeWidth={2.2} />
          </button>
          <h2 className={styles.title}>
            <FormattedMessage id={`settingsPopover.${sub}`} />
          </h2>
          <IconButton size={28} variant="ghost" label={t('settingsPopover.close')} icon={<Icon name="close" size={16} />} onClick={onClose} />
        </div>
        <div className={`rl-reveal ${styles.subBody}`}>
          <OptionList
            label={t(`settingsPopover.${sub}`)}
            options={list.options}
            value={list.value}
            onSelect={(v) => {
              list.onSelect(v);
              back();
            }}
            onEscape={back}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>
          <FormattedMessage id="settingsPopover.title" />
        </h2>
        <IconButton size={28} variant="ghost" label={t('settingsPopover.close')} icon={<Icon name="close" size={16} />} onClick={onClose} />
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
                modeRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={styles.mode}
              onClick={() => pick(m.value)}
              onKeyDown={(e) => onModeKeyDown(e, i)}
            >
              <span className={styles.modeIcon}>
                <Icon name={m.icon} size={15} />
              </span>
              <span className={styles.modeText}>
                <span className={styles.modeName}>
                  <FormattedMessage
                    id="settingsPopover.creationMode.option"
                    values={{
                      label: t(`settingsPopover.creationMode.${m.value}`),
                      sub: t(`settingsPopover.creationMode.${m.value}.sub`),
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
      {SUBS.map((s) => (
        <button
          key={s}
          ref={(el) => {
            if (el) rowRefs.current.set(s, el);
            else rowRefs.current.delete(s);
          }}
          type="button"
          className={styles.row}
          aria-haspopup="menu"
          aria-label={t('settingsPopover.row', { label: t(`settingsPopover.${s}`), value: values[s] })}
          data-row={s}
          onClick={() => open(s)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              open(s);
            }
          }}
        >
          <span className={styles.rowLabel}>
            <FormattedMessage id={`settingsPopover.${s}`} />
          </span>
          <span className={styles.rowValue} lang={s === 'language' ? current.tag : undefined}>
            {values[s]} <span aria-hidden="true">›</span>
          </span>
        </button>
      ))}
    </div>
  );
}
