import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { en, Messages } from './en';
import { zh } from './zh';

export type Locale = 'en' | 'zh';

export const LOCALE_STORAGE_KEY = 'ovid-locale';

const dictionaries: Record<Locale, Messages> = { en, zh };

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale];
}

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh';
}

/** Stored preference first, then the browser language, then English. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage may be unavailable (private mode) — fall through.
  }
  const nav =
    typeof navigator !== 'undefined'
      ? navigator.languages?.[0] || navigator.language || ''
      : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Messages;
}

// Default value keeps components working (in English) even when rendered
// without a provider, e.g. in unit tests.
const I18nContext = createContext<I18nValue>({
  locale: 'en',
  setLocale: () => {},
  t: en,
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Preference just won't persist.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, t: dictionaries[locale] }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
