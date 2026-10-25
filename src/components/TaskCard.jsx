import { useI18n } from '../i18n/I18nProvider.jsx';
import { labelColor } from '../utils/labelColor.js';
import DueDate from './DueDate.jsx';
import PlannedSlot from './PlannedSlot.jsx';
import SubtaskProgress from './SubtaskProgress.jsx';
import { CheckCircleIcon, FolderIcon, GripIcon, PencilIcon, TrashIcon } from './Icons.jsx';

// `dragProps` is provided by the sortable wrapper on the board; the drag overlay
// renders a static copy with `isOverlay`.
// `categoryName` is shown as a small tag (only passed in the All Tasks view).
export default function TaskCard({ task, onEdit, onDelete, dragProps, categoryName, isPlaceholder = false, isOverlay = false }) {
  const { t } = useI18n();
  const done = task.status === 'done';
  const hasFooter = task.labels.length > 0 || task.dueDate || categoryName || task.subtasks?.length > 0 || Boolean(task.planned);
  const interactive = !isOverlay;

  const classes = ['task-card'];
  if (done) classes.push('is-done');
  if (dragProps) classes.push('is-sortable');
  if (isPlaceholder) classes.push('is-placeholder');
  if (isOverlay) classes.push('is-overlay');

  return (
    <article
      ref={dragProps?.ref}
      style={dragProps?.style}
      className={classes.join(' ')}
      aria-hidden={isOverlay || undefined}
      {...dragProps?.listeners}
    >
      <div className="task-card__top">
        <span className={`priority priority--${task.priority}`}>
          <span className="priority__dot" aria-hidden="true" />
          <span className="visually-hidden">{t('priority.label')}: </span>
          {t(`priority.${task.priority}`)}
        </span>
        <div className="task-card__aside">
          {(dragProps || isOverlay) && (
            <button
              type="button"
              ref={dragProps?.handleRef}
              className="icon-btn icon-btn--sm task-card__handle"
              data-drag-handle
              aria-label={t('dnd.handle', { title: task.title })}
              title={t('dnd.handleTitle')}
              tabIndex={interactive ? 0 : -1}
              {...dragProps?.handleAttributes}
            >
              <GripIcon size={15} />
            </button>
          )}
          {interactive && (
            <div className="task-card__actions">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                data-no-dnd
                // The title button opens the same editor, so this icon is not a separate Tab stop.
                tabIndex={-1}
                aria-label={t('task.editTask', { title: task.title })}
                title={t('actions.edit')}
                onClick={() => onEdit(task.id)}
              >
                <PencilIcon size={15} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--danger"
                data-no-dnd
                aria-label={t('task.deleteTask', { title: task.title })}
                title={t('actions.delete')}
                onClick={() => onDelete(task.id)}
              >
                <TrashIcon size={15} />
              </button>
            </div>
          )}
          {done && (
            <span className="task-card__done" title={t('task.completed')}>
              <CheckCircleIcon size={16} />
            </span>
          )}
        </div>
      </div>

      <h3 className="task-card__title">
        {interactive ? (
          <button type="button" className="task-card__open" data-task-focus={task.id} onClick={() => onEdit(task.id)}>
            {task.title}
          </button>
        ) : (
          <span className="task-card__open">{task.title}</span>
        )}
      </h3>
      {task.description && <p className="task-card__description">{task.description}</p>}

      {hasFooter && (
        <div className="task-card__footer">
          <SubtaskProgress task={task} />
          {categoryName && (
            <span className="task-card__category" title={`${t('taskForm.category')}: ${categoryName}`}>
              <FolderIcon size={12} />
              <span className="visually-hidden">{t('taskForm.category')}: </span>
              <span className="task-card__category-name">{categoryName}</span>
            </span>
          )}
          <ul className="task-card__labels" aria-label={t('task.labels')}>
            {task.labels.map((label) => (
              <li key={label} className="label" style={{ '--label-color': labelColor(label) }}>
                {label}
              </li>
            ))}
          </ul>
          <PlannedSlot task={task} />
          <DueDate task={task} />
        </div>
      )}
    </article>
  );
}
