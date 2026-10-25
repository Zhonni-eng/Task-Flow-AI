import { useI18n } from '../i18n/I18nProvider.jsx';
import { GlobeIcon } from './Icons.jsx';

export default function LanguageSwitcher() {
  const { language, languages, setLanguage, t } = useI18n();

  return (
    <div className="lang-switcher" role="radiogroup" aria-label={t('language.label')}>
      <GlobeIcon size={16} className="lang-switcher__icon" />
      {languages.map((lang) => {
        const active = lang.code === language;
        return (
          <button
            key={lang.code}
            type="button"
            role="radio"
            aria-checked={active}
            lang={lang.code}
            title={active ? lang.name : t('language.switchTo', { name: lang.name })}
            className={`lang-switcher__option${active ? ' is-active' : ''}`}
            onClick={() => setLanguage(lang.code)}
          >
            {lang.shortLabel}
          </button>
        );
      })}
    </div>
  );
}
