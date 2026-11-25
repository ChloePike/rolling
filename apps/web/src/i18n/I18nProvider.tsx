import { useEffect, useState, type ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { englishMessages as en } from './messages';
import { browserLocales, DEFAULT_LOCALE, readLocalePreference, resolveLocale } from './locale';
import { loadMessages, type Messages } from './messages';

/**
 * Provides react-intl. English ships in the main bundle so the first paint
 * never waits; another resolved locale loads its messages and swaps in.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ locale: string; messages: Messages }>({
    locale: DEFAULT_LOCALE,
    messages: en,
  });

  useEffect(() => {
    const locale = resolveLocale(readLocalePreference(), browserLocales());
    if (locale === DEFAULT_LOCALE) return;
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
  }, []);

  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);

  return (
    <IntlProvider locale={state.locale} defaultLocale={DEFAULT_LOCALE} messages={state.messages}>
      {children}
    </IntlProvider>
  );
}
