import { useEffect, useId, useRef, useState } from 'react';
import { COLUMNS } from '../data/board.js';
import { DUE_FILTERS } from '../data/dueDates.js';
import { PRIORITIES } from '../data/taskModel.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { labelColor } from '../utils/labelColor.js';
import { AlertIcon, CalendarIcon, CheckIcon, ClockIcon, FilterIcon } from './Icons.jsx';

const DUE_ICONS = { overdue: AlertIcon, today: ClockIcon, upcoming: CalendarIcon };

const toggle = (list, value) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

function Option({ checked, onChange, children, style }) {
  return (
    <label className={`filter-option${checked ? ' is-checked' : ''}`} style={style}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>
        {children}
        <CheckIcon size={14} className="filter-option__check" />
      </span>
    </label>
  );
}

// Dropdown with status, due date, priority and label filters (multi-select within each group).
export default function FilterMenu({ view, onChange, labels }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuId = useId();
  const due = view.due ?? [];
  const activeCount = view.statuses.length + due.length + view.priorities.length + view.labels.length;

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [open]);

  const set = (field, value) => onChange({ ...view, [field]: toggle(view[field] ?? [], value) });

  return (
    <div
      className="filter-menu"
      ref={rootRef}
      onBlur={(event) => {
        // Tabbing out closes the menu (mouse clicks outside are handled on mousedown).
        if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`btn btn--ghost toolbar__button${activeCount ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        <FilterIcon size={16} />
        {t('filters.button')}
        {activeCount > 0 && <span className="toolbar__badge">{activeCount}</span>}
      </button>

      {open && (
        <div id={menuId} className="filter-menu__popover" role="group" aria-label={t('filters.button')}>
          <fieldset className="filter-menu__group">
            <legend>{t('filters.status')}</legend>
            {COLUMNS.map((column) => (
              <Option key={column.id} checked={view.statuses.includes(column.id)} onChange={() => set('statuses', column.id)}>
                <span className={`filter-option__dot filter-option__dot--${column.id}`} aria-hidden="true" />
                {t(column.titleKey)}
              </Option>
            ))}
          </fieldset>

          <fieldset className="filter-menu__group">
            <legend>{t('filters.due')}</legend>
            {DUE_FILTERS.map((filter) => {
              const Icon = DUE_ICONS[filter];
              return (
                <Option key={filter} checked={due.includes(filter)} onChange={() => set('due', filter)}>
                  <Icon size={14} className={`filter-option__due filter-option__due--${filter}`} />
                  {t(`filters.dueOptions.${filter}`)}
                </Option>
              );
            })}
          </fieldset>

          <fieldset className="filter-menu__group">
            <legend>{t('filters.priority')}</legend>
            {[...PRIORITIES].reverse().map((priority) => (
              <Option key={priority} checked={view.priorities.includes(priority)} onChange={() => set('priorities', priority)}>
                <span className={`priority__dot filter-option__priority--${priority}`} aria-hidden="true" />
                {t(`priority.${priority}`)}
              </Option>
            ))}
          </fieldset>

          <fieldset className="filter-menu__group filter-menu__group--labels">
            <legend>{t('filters.labels')}</legend>
            {labels.length === 0 && <p className="filter-menu__empty">{t('filters.noLabels')}</p>}
            {labels.map((label) => (
              <Option
                key={label}
                checked={view.labels.some((item) => item.toLocaleLowerCase() === label.toLocaleLowerCase())}
                onChange={() => {
                  const key = label.toLocaleLowerCase();
                  const selected = view.labels.some((item) => item.toLocaleLowerCase() === key);
                  onChange({
                    ...view,
                    labels: selected ? view.labels.filter((item) => item.toLocaleLowerCase() !== key) : [...view.labels, label],
                  });
                }}
                style={{ '--label-color': labelColor(label) }}
              >
                <span className="filter-option__swatch" aria-hidden="true" />
                {label}
              </Option>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
