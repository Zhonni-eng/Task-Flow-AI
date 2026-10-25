import { useI18n } from '../i18n/I18nProvider.jsx';
import { ChevronIcon, PencilIcon, PlusIcon, SparkleIcon, TrashIcon } from './Icons.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';

/**
 * `title` is the selected sidebar destination. When a category is selected,
 * `categoryActions` ({ onRename, onDelete }) adds rename/delete buttons next to it,
 * which keeps category management reachable even in the collapsed sidebar.
 */
export default function Header({ title, layout, categoryActions, onCreateTask, onOpenAssistant, assistantOpen }) {
  const { t, formatDate } = useI18n();
  const today = formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <header className="header">
      <div className="header__titles">
        <div className="header__breadcrumb">
          <span>{t('nav.sectionTasks')}</span>
          <ChevronIcon size={14} />
          <span className="header__breadcrumb-current">{t(`layout.${layout}`)}</span>
        </div>
        <div className="header__title-row">
          <h1 className="header__title" title={title}>
            {title}
          </h1>
          {categoryActions && (
            <span className="header__title-actions">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={t('categories.renameNamed', { name: title })}
                title={t('categories.rename')}
                onClick={categoryActions.onRename}
              >
                <PencilIcon size={15} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--danger"
                aria-label={t('categories.deleteNamed', { name: title })}
                title={t('categories.delete')}
                onClick={categoryActions.onDelete}
              >
                <TrashIcon size={15} />
              </button>
            </span>
          )}
        </div>
        <p className="header__meta">
          <span>{t('header.today', { date: today })}</span>
        </p>
      </div>
      <div className="header__actions">
        {onOpenAssistant && (
          <button
            type="button"
            className={`icon-btn header__ai${assistantOpen ? ' is-active' : ''}`}
            aria-label={t('assistant.open')}
            title={t('assistant.open')}
            aria-expanded={Boolean(assistantOpen)}
            data-focus-target="assistant"
            onClick={onOpenAssistant}
          >
            <SparkleIcon size={18} />
          </button>
        )}
        <LanguageSwitcher />
        <button type="button" className="btn btn--primary" data-focus-target="new-task" onClick={onCreateTask}>
          <PlusIcon size={16} />
          {t('actions.newTask')}
        </button>
      </div>
    </header>
  );
}
