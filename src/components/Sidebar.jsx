import { useI18n } from '../i18n/I18nProvider.jsx';
import { ALL_TASKS, UNCATEGORIZED } from '../state/taskView.js';
import { labelColor } from '../utils/labelColor.js';
import { BoardIcon, FolderIcon, LogoIcon, OfflineIcon, PencilIcon, PlusIcon, TrashIcon, GearIcon } from './Icons.jsx';

// Injected at build time from package.json (see vite.config.js).
const APP_VERSION = __APP_VERSION__;

function NavItem({ active, icon, name, count, color, onSelect, actions, focusTarget }) {
  const { t } = useI18n();
  const countLabel = t('categories.taskCount', { count });
  return (
    <li className={`sidebar__item${active ? ' is-active' : ''}`} style={color ? { '--category-color': color } : undefined}>
      <button
        type="button"
        className="sidebar__link"
        data-focus-target={focusTarget}
        aria-current={active ? 'page' : undefined}
        aria-label={`${name}, ${countLabel}`}
        title={`${name} · ${countLabel}`}
        onClick={onSelect}
      >
        {icon}
        <span className="sidebar__link-text">{name}</span>
        <span className="sidebar__count" aria-hidden="true">
          {count}
        </span>
      </button>
      {actions}
    </li>
  );
}

// Category creation and renaming happen in a dialog (works in the collapsed sidebar too).
export default function Sidebar({ categories, counts, destination, onSelect, onRequestCreate, onRequestRename, onRequestDelete, onOpenSettings }) {
  const { t } = useI18n();

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">
          <LogoIcon size={20} />
        </span>
        <span className="sidebar__brand-text">
          <span className="sidebar__name">{t('app.name')}</span>
          <span className="sidebar__tagline">{t('app.tagline')}</span>
        </span>
      </div>

      <nav className="sidebar__nav" aria-label={t('nav.mainLabel')}>
        <ul className="sidebar__list">
          <NavItem
            active={destination === ALL_TASKS}
            icon={<BoardIcon />}
            name={t('nav.allTasks')}
            count={counts[ALL_TASKS] ?? 0}
            onSelect={() => onSelect(ALL_TASKS)}
            focusTarget="all-tasks"
          />
        </ul>

        <div className="sidebar__section-row">
          <p className="sidebar__section" id="sidebar-categories">
            {t('nav.sectionCategories')}
          </p>
          <button
            type="button"
            className="icon-btn icon-btn--sm sidebar__add"
            aria-label={t('categories.add')}
            title={t('categories.add')}
            onClick={onRequestCreate}
          >
            <PlusIcon size={15} />
          </button>
        </div>

        <ul className="sidebar__list sidebar__list--categories" aria-labelledby="sidebar-categories">
          {categories.map((category) => (
            <NavItem
              key={category.id}
              active={destination === category.id}
              color={labelColor(category.id)}
              icon={
                <span className="sidebar__category-mark" aria-hidden="true">
                  {category.name.charAt(0).toLocaleUpperCase()}
                </span>
              }
              name={category.name}
              count={counts[category.id] ?? 0}
              onSelect={() => onSelect(category.id)}
              actions={
                <span className="sidebar__item-actions">
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label={t('categories.renameNamed', { name: category.name })}
                    title={t('categories.rename')}
                    onClick={() => onRequestRename(category.id)}
                  >
                    <PencilIcon size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm icon-btn--danger"
                    aria-label={t('categories.deleteNamed', { name: category.name })}
                    title={t('categories.delete')}
                    onClick={() => onRequestDelete(category.id)}
                  >
                    <TrashIcon size={13} />
                  </button>
                </span>
              }
            />
          ))}

          {categories.length === 0 && <li className="sidebar__hint">{t('categories.emptyHint')}</li>}

          <NavItem
            active={destination === UNCATEGORIZED}
            icon={<FolderIcon />}
            name={t('nav.uncategorized')}
            count={counts[UNCATEGORIZED] ?? 0}
            onSelect={() => onSelect(UNCATEGORIZED)}
          />
        </ul>
      </nav>

      <div className="sidebar__footer">
        <span className="sidebar__status" title={t('app.offline')}>
          <OfflineIcon size={16} />
          <span className="sidebar__link-text">{t('app.offline')}</span>
        </span>
        {onOpenSettings && (
          <button type="button" className="sidebar__link sidebar__settings" title={t('appSettings.open')} onClick={onOpenSettings}>
            <GearIcon size={16} />
            <span className="sidebar__link-text">{t('appSettings.open')}</span>
          </button>
        )}
        <span className="sidebar__version">{t('app.version', { version: APP_VERSION })}</span>
      </div>
    </aside>
  );
}
