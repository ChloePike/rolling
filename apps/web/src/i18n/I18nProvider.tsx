import { useEffect, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { englishMessages as en } from './messages';
import { useLanguagePref } from '@/lib/prefs';
import { browserLocales, DEFAULT_LOCALE, resolveLocale } from './locale';
import { loadMessages, type Messages } from './messages';

/** The canonical tag of a saved preference, if it is a valid locale. */
function formatLocale(tag: string | null): string | null {
  if (!tag) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Provides react-intl. English ships in the main bundle so the first paint
 * never waits; another resolved locale loads its messages and swaps in.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ locale: string; messages: Messages }>({
    locale: DEFAULT_LOCALE,
    messages: en,
  });

  // The language preference (Settings → Preferences, header settings) is shared through lib/prefs.
  const preference = useLanguagePref();

  useEffect(() => {
    const locale = resolveLocale(preference, browserLocales());
    if (locale === DEFAULT_LOCALE) {
      // A chosen language without translations yet: English text, that language's
      // number, date and currency formats (interaction pass).
      const formats = formatLocale(preference) ?? DEFAULT_LOCALE;
      setState((s) => (s.locale === formats && s.messages === en ? s : { locale: formats, messages: en }));
      return;
    }
    let cancelled = false;
    loadMessages(locale)
      .then((messages) => {
        if (!cancelled) setState({ locale, messages });
      })
      .catch(() => {
        /* Keep English when a locale file fails to load. */
      });
    return () => {
      cancelled = true;
    };
  }, [preference]);

  useEffect(() => {
    // The text is English until a locale has messages; `lang` names the text's language.
    document.documentElement.lang = state.messages === en ? DEFAULT_LOCALE : state.locale;
  }, [state.locale, state.messages]);

  return (
    <IntlProvider locale={state.locale} defaultLocale={DEFAULT_LOCALE} messages={state.messages}>
      {children}
    </IntlProvider>
  );
}
