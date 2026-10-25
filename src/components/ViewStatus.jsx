import { COLUMNS } from '../data/board.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { EMPTY_VIEW, isFiltering } from '../state/taskView.js';
import { CloseIcon, LockIcon, PlusIcon } from './Icons.jsx';

function Chip({ label, onRemove, removeLabel }) {
  return (
    <span className="view-chip">
      {label}
      <button type="button" className="view-chip__remove" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
        <CloseIcon size={11} />
      </button>
    </span>
  );
}

// Second toolbar line: what is currently hidden or reordered, and how to undo it.
// `emptyMessage` is shown when the current destination has no tasks at all.
export default function ViewStatus({ view, onViewChange, shown, total, dragAllowed, layout, emptyMessage, onCreateTask }) {
  const { t } = useI18n();
  const filtering = isFiltering(view);

  if (total === 0) {
    return (
      <div className="view-status view-status--empty" role="status">
        <span>{emptyMessage}</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCreateTask}>
          <PlusIcon size={14} />
          {t('actions.newTask')}
        </button>
      </div>
    );
  }
  if (!filtering && dragAllowed) return null;

  const without = (field, value) => onViewChange({ ...view, [field]: view[field].filter((item) => item !== value) });
  const chip = (key, label, onRemove) => (
    <Chip key={key} label={label} onRemove={onRemove} removeLabel={t('view.removeFilter', { name: label })} />
  );

  const chips = [];
  if (view.query.trim()) {
    chips.push(chip('q', t('view.searchChip', { query: view.query.trim() }), () => onViewChange({ ...view, query: '' })));
  }
  for (const status of view.statuses) {
    const column = COLUMNS.find((item) => item.id === status);
    chips.push(chip(`s-${status}`, t(column.titleKey), () => without('statuses', status)));
  }
  for (const filter of view.due ?? []) {
    chips.push(chip(`d-${filter}`, t(`filters.dueOptions.${filter}`), () => without('due', filter)));
  }
  for (const priority of view.priorities) {
    chips.push(chip(`p-${priority}`, t(`priority.${priority}`), () => without('priorities', priority)));
  }
  for (const label of view.labels) {
    chips.push(chip(`l-${label}`, label, () => without('labels', label)));
  }
  if (view.sort !== 'manual') {
    chips.push(chip('sort', t(`toolbar.sort.${view.sort}`), () => onViewChange({ ...view, sort: 'manual' })));
  }

  return (
    <div className="view-status" role="status">
      {filtering && <span className="view-status__count">{t('view.showing', { shown, total })}</span>}
      <div className="view-status__chips">{chips}</div>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => onViewChange(EMPTY_VIEW)}>
        {t('view.resetAll')}
      </button>
      {!dragAllowed && layout === 'board' && (
        <span className="view-status__hint">
          <LockIcon size={14} />
          {t('view.dragDisabled')}
        </span>
      )}
    </div>
  );
}
