import { useEffect, useRef } from 'react';
import { COLUMNS } from '../data/board.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { labelColor } from '../utils/labelColor.js';
import DueDate from './DueDate.jsx';
import SubtaskProgress from './SubtaskProgress.jsx';
import { PencilIcon, TrashIcon } from './Icons.jsx';

/** Header checkbox: checked when every visible task is selected, mixed when some are. */
function SelectAllCheckbox({ selection, label, disabled }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selection.someSelected;
  }, [selection.someSelected]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="task-list__checkbox"
      data-focus-target="select-all"
      checked={selection.allSelected}
      disabled={disabled}
      aria-label={label}
      title={label}
      onChange={selection.toggleAll}
    />
  );
}

/**
 * Compact list of the same tasks shown on the board. Rows open the shared edit dialog;
 * status changes go through the same reducer as drag-and-drop. No drag-and-drop here.
 * `selection` (from useSelection) drives the checkbox column used by bulk actions.
 */
export default function TaskList({ tasks, categoryNameOf, showCategory, selection, onEditTask, onDeleteTask, onStatusChange }) {
  const { t } = useI18n();

  return (
    <div className={`task-list${showCategory ? '' : ' task-list--no-category'}`} role="table" aria-label={t('list.label')}>
      <div className="task-list__row task-list__row--head" role="row">
        <span role="columnheader" className="task-list__select">
          <SelectAllCheckbox selection={selection} label={t('list.selectAll')} disabled={tasks.length === 0} />
        </span>
        <span role="columnheader">{t('list.task')}</span>
        {showCategory && (
          <span role="columnheader" className="task-list__col--category">
            {t('taskForm.category')}
          </span>
        )}
        <span role="columnheader">{t('list.status')}</span>
        <span role="columnheader" className="task-list__col--priority">
          {t('priority.label')}
        </span>
        <span role="columnheader" className="task-list__col--due">
          {t('taskForm.dueDate')}
        </span>
        <span role="columnheader" className="task-list__col--labels">
          {t('taskForm.labels')}
        </span>
        <span role="columnheader" className="visually-hidden">
          {t('list.actions')}
        </span>
      </div>

      {tasks.length === 0 && (
        <div className="task-list__empty" role="row">
          <span role="cell">{t('list.empty')}</span>
        </div>
      )}

      {tasks.map((task) => (
        <div
          key={task.id}
          className={`task-list__row${task.status === 'done' ? ' is-done' : ''}${selection.isSelected(task.id) ? ' is-selected' : ''}`}
          role="row"
        >
          <span role="cell" className="task-list__select">
            <input
              type="checkbox"
              className="task-list__checkbox"
              checked={selection.isSelected(task.id)}
              aria-label={t('list.selectTask', { title: task.title })}
              onChange={() => selection.toggle(task.id)}
            />
          </span>
          <span role="cell" className="task-list__title-cell">
            <button type="button" className="task-list__title" title={task.title} data-task-focus={task.id} onClick={() => onEditTask(task.id)}>
              {task.title}
            </button>
            {(task.description || task.subtasks?.length > 0) && (
              <span className="task-list__meta">
                <SubtaskProgress task={task} />
                {task.description && <span className="task-list__description">{task.description}</span>}
              </span>
            )}
          </span>
          {showCategory && (
            <span role="cell" className="task-list__col--category task-list__category" title={categoryNameOf(task)}>
              {categoryNameOf(task)}
            </span>
          )}
          <span role="cell">
            <select
              className={`task-list__status task-list__status--${task.status}`}
              value={task.status}
              aria-label={t('list.changeStatus', { title: task.title })}
              onChange={(event) => onStatusChange(task.id, event.target.value)}
            >
              {COLUMNS.map((column) => (
                <option key={column.id} value={column.id}>
                  {t(column.titleKey)}
                </option>
              ))}
            </select>
          </span>
          <span role="cell" className="task-list__col--priority">
            <span className={`priority priority--${task.priority}`}>
              <span className="priority__dot" aria-hidden="true" />
              {t(`priority.${task.priority}`)}
            </span>
          </span>
          <span role="cell" className="task-list__col--due">
            <DueDate task={task} variant="list" />
          </span>
          <span role="cell" className="task-list__col--labels task-list__labels">
            {task.labels.length === 0 ? (
              <span className="task-list__muted">—</span>
            ) : (
              task.labels.map((label) => (
                <span key={label} className="label" style={{ '--label-color': labelColor(label) }}>
                  {label}
                </span>
              ))
            )}
          </span>
          <span role="cell" className="task-list__actions">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              // The title button opens the same editor, so this icon is not a separate Tab stop.
              tabIndex={-1}
              aria-label={t('task.editTask', { title: task.title })}
              title={t('actions.edit')}
              onClick={() => onEditTask(task.id)}
            >
              <PencilIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm icon-btn--danger"
              aria-label={t('task.deleteTask', { title: task.title })}
              title={t('actions.delete')}
              onClick={() => onDeleteTask(task.id)}
            >
              <TrashIcon size={15} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
