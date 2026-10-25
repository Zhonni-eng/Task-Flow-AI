import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { SORT_MODES } from '../state/taskView.js';
import FilterMenu from './FilterMenu.jsx';
import { BoardIcon, CloseIcon, ListIcon, SearchIcon, SortIcon } from './Icons.jsx';

const LAYOUTS = [
  { id: 'board', icon: BoardIcon },
  { id: 'list', icon: ListIcon },
];

// View switcher, search, filters and sorting above the tasks.
export default function Toolbar({ layout, onLayoutChange, view, onViewChange, labels }) {
  const { t } = useI18n();
  const searchRef = useRef(null);
  const sortId = useId();

  // Ctrl+F focuses the search field.
  useEffect(() => {
    const handleKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="toolbar">
      <div className="toolbar__controls">
        <div className="layout-switch" role="group" aria-label={t('layout.label')}>
          {LAYOUTS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`layout-switch__option${layout === id ? ' is-active' : ''}`}
              aria-pressed={layout === id}
              aria-label={t(`layout.${id}`)}
              title={t(`layout.${id}`)}
              onClick={() => onLayoutChange(id)}
            >
              <Icon size={16} />
              <span>{t(`layout.${id}`)}</span>
            </button>
          ))}
        </div>

        <div className="search">
          <SearchIcon size={16} className="search__icon" />
          <input
            ref={searchRef}
            type="search"
            className="search__input"
            value={view.query}
            placeholder={t('toolbar.searchPlaceholder')}
            aria-label={t('toolbar.searchLabel')}
            onChange={(event) => onViewChange({ ...view, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && view.query) {
                event.preventDefault();
                onViewChange({ ...view, query: '' });
              }
            }}
          />
          {view.query && (
            <button
              type="button"
              className="icon-btn icon-btn--sm search__clear"
              aria-label={t('toolbar.clearSearch')}
              title={t('toolbar.clearSearch')}
              onClick={() => {
                onViewChange({ ...view, query: '' });
                searchRef.current?.focus();
              }}
            >
              <CloseIcon size={13} />
            </button>
          )}
        </div>

        <FilterMenu view={view} onChange={onViewChange} labels={labels} />

        <label className={`sort${view.sort !== 'manual' ? ' is-active' : ''}`} htmlFor={sortId}>
          <SortIcon size={16} className="sort__icon" />
          <span className="visually-hidden">{t('toolbar.sortLabel')}</span>
          <select
            id={sortId}
            className="sort__select"
            value={view.sort}
            title={t('toolbar.sortLabel')}
            onChange={(event) => onViewChange({ ...view, sort: event.target.value })}
          >
            {SORT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`toolbar.sort.${mode}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

    </div>
  );
}
