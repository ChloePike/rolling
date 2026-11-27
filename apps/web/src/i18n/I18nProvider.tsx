import { useEffect, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { MOCK_BUILD } from '@/lib/api/mode';
import { getLanguage, useLanguagePref } from '@/lib/prefs';
import { browserLocales, DEFAULT_LOCALE, resolveLocale } from './locale';
import { englishMessages as en, loadMessages, type Messages } from './messages';

interface I18nState {
  /** The locale react-intl formats with (dates, numbers, plurals). */
  locale: string;
  messages: Messages;
  /** The language of the text: `<html lang>`. English while a locale has no translations. */
  lang: string;
}

/** The canonical tag of a saved preference, if it is a valid locale. */
function formatLocale(tag: string | null): string | null {
  if (!tag) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

const PSEUDO = 'en-XA';

/**
 * The state for a language preference (null = follow the browser, D-023): a translated
 * locale loads its chunk with English per missing key; a listed but untranslated language
 * keeps English text with that language's formats.
 */
export async function stateFor(preference: string | null): Promise<I18nState> {
  if (MOCK_BUILD && preference === PSEUDO) {
    const { pseudoMessages } = await import('./pseudo');
    return { locale: 'en', messages: pseudoMessages(en), lang: PSEUDO };
  }
  // A saved choice is final: Deutsch stays English text with German formats, never the browser's Korean.
  const chosen = formatLocale(preference);
  const locale = resolveLocale(chosen, chosen ? [] : browserLocales());
  if (locale === DEFAULT_LOCALE) {
    const formats = formatLocale(preference) ?? DEFAULT_LOCALE;
    return { locale: formats, messages: en, lang: DEFAULT_LOCALE };
  }
  try {
    return { locale, messages: await loadMessages(locale), lang: locale };
  } catch {
    // Keep English when a locale chunk fails to load (offline, stale deploy).
    return { locale, messages: en, lang: DEFAULT_LOCALE };
  }
}

const ENGLISH: I18nState = { locale: DEFAULT_LOCALE, messages: en, lang: DEFAULT_LOCALE };
let initial: I18nState = ENGLISH;

function applyLang(lang: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/**
 * Loads the saved (or browser) locale before the first render so a Japanese visitor never
 * sees an English flash. The app entry awaits it next to the mock data.
 */
export async function preloadLocale(): Promise<void> {
  initial = await stateFor(getLanguage());
  applyLang(initial.lang);
}

/**
 * Provides react-intl. English ships in the main bundle; another locale is one lazy chunk,
 * preloaded at startup and swapped in without a reload when the preference changes.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<I18nState>(initial);
  // The language preference (Settings → Preferences, header settings) is shared through lib/prefs.
  const preference = useLanguagePref();

  useEffect(() => {
    let cancelled = false;
    void stateFor(preference).then((next) => {
      if (cancelled) return;
      setState((s) => (s.locale === next.locale && s.lang === next.lang && s.messages === next.messages ? s : next));
    });
    return () => {
      cancelled = true;
    };
  }, [preference]);

  useEffect(() => applyLang(state.lang), [state.lang]);

  return (
    <IntlProvider locale={state.locale} defaultLocale={DEFAULT_LOCALE} messages={state.messages}>
      {children}
    </IntlProvider>
  );
}
