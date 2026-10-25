import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LANGUAGE, LANGUAGES, translations } from './translations.js';

const I18nContext = createContext(null);

function isSupported(code) {
  return LANGUAGES.some((lang) => lang.code === code);
}

function lookup(dictionary, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dictionary);
}

function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}

// `initialLanguage` comes from saved settings; `onLanguageChange` persists user choices.
export function I18nProvider({ initialLanguage = DEFAULT_LANGUAGE, onLanguageChange, children }) {
  const [language, setLanguageState] = useState(() =>
    isSupported(initialLanguage) ? initialLanguage : DEFAULT_LANGUAGE,
  );

  const meta = LANGUAGES.find((lang) => lang.code === language);
  const locale = meta.locale;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback(
    (code) => {
      if (!isSupported(code) || code === language) return;
      setLanguageState(code);
      onLanguageChange?.(code);
    },
    [language, onLanguageChange],
  );

  const t = useCallback(
    (key, params = {}) => {
      let value = lookup(translations[language], key);
      if (value === undefined) value = lookup(translations[DEFAULT_LANGUAGE], key);
      if (value === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] Missing translation: ${key}`);
        return key;
      }
      if (typeof value === 'object' && typeof params.count === 'number') {
        const category = new Intl.PluralRules(locale).select(params.count);
        value = value[category] ?? value.other;
      }
      return typeof value === 'string' ? interpolate(value, params) : key;
    },
    [language, locale],
  );

  const formatDate = useCallback(
    (date, options = { day: 'numeric', month: 'short' }) =>
      new Intl.DateTimeFormat(locale, options).format(date),
    [locale],
  );

  const weekStart = meta.weekStart;

  const value = useMemo(
    () => ({ language, locale, weekStart, languages: LANGUAGES, setLanguage, t, formatDate }),
    [language, locale, weekStart, setLanguage, t, formatDate],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}
