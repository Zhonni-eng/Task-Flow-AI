import { useEffect, useId, useRef, useState } from 'react';
import { SUBTASK_LIMIT, SUBTASK_TITLE_LIMIT, createSubtask, subtaskProgress, validateSubtaskTitle } from '../data/subtasks.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { PlusIcon, TrashIcon } from './Icons.jsx';

/**
 * Subtask section of the task dialog. Works on the form's copy of the list (`subtasks`),
 * so changes are saved or discarded together with the rest of the task.
 * `errors` maps subtask id (or 'new') to an error code; the parent validates on submit.
 * Tasks without subtasks only show a single "add subtasks" button.
 */
export default function SubtaskEditor({ subtasks, onChange, draft, onDraftChange, errors, onErrorsChange }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(subtasks.length > 0);
  const [focusNew, setFocusNew] = useState(false);
  const headingId = useId();
  const newId = useId();
  const newInputRef = useRef(null);
  const progress = subtaskProgress({ subtasks });
  const full = subtasks.length >= SUBTASK_LIMIT;

  // After "Add subtasks" expands the section, move focus straight to the new-subtask field.
  useEffect(() => {
    if (expanded && focusNew) {
      newInputRef.current?.focus();
      setFocusNew(false);
    }
  }, [expanded, focusNew]);

  const clearError = (key) => {
    if (errors[key]) onErrorsChange({ ...errors, [key]: undefined });
  };

  const add = () => {
    const error = validateSubtaskTitle(draft);
    if (error) {
      onErrorsChange({ ...errors, new: error });
      newInputRef.current?.focus();
      return;
    }
    onChange([...subtasks, createSubtask(draft)]);
    onDraftChange('');
    clearError('new');
    newInputRef.current?.focus();
  };

  const update = (id, changes) => onChange(subtasks.map((subtask) => (subtask.id === id ? { ...subtask, ...changes } : subtask)));
  const remove = (id) => {
    onChange(subtasks.filter((subtask) => subtask.id !== id));
    clearError(id);
    newInputRef.current?.focus();
  };

  if (!expanded) {
    return (
      <div className="field">
        <button
          type="button"
          className="btn btn--sm btn--ghost subtasks__open"
          onClick={() => {
            setExpanded(true);
            setFocusNew(true);
          }}
        >
          <PlusIcon size={14} />
          {t('subtasks.open')}
        </button>
      </div>
    );
  }

  return (
    <section className="field subtasks" aria-labelledby={headingId}>
      <div className="subtasks__header">
        <h3 id={headingId} className="field-label">
          {t('subtasks.title')}
          <span className="field-label__optional">{t('taskForm.optional')}</span>
        </h3>
        {progress && (
          <span className="subtasks__summary" aria-label={t('subtasks.progress', progress)}>
            <span className="subtasks__bar" aria-hidden="true">
              <span className="subtasks__bar-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </span>
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <ul className="subtasks__list">
          {subtasks.map((subtask, index) => {
            const name = subtask.title.trim() || t('subtasks.untitled', { number: index + 1 });
            const errorId = `${headingId}-error-${index}`;
            return (
              <li key={subtask.id} className={`subtasks__item${subtask.done ? ' is-done' : ''}`}>
                <input
                  type="checkbox"
                  className="task-list__checkbox subtasks__check"
                  checked={subtask.done}
                  aria-label={t('subtasks.toggle', { title: name })}
                  onChange={(event) => update(subtask.id, { done: event.target.checked })}
                />
                <div className="subtasks__title-wrap">
                  <input
                    className={`subtasks__input${errors[subtask.id] ? ' has-error' : ''}`}
                    value={subtask.title}
                    maxLength={SUBTASK_TITLE_LIMIT}
                    aria-label={t('subtasks.titleLabel', { number: index + 1 })}
                    aria-invalid={Boolean(errors[subtask.id])}
                    aria-describedby={errors[subtask.id] ? errorId : undefined}
                    data-subtask-id={subtask.id}
                    onChange={(event) => {
                      update(subtask.id, { title: event.target.value });
                      clearError(subtask.id);
                    }}
                    onKeyDown={(event) => {
                      // Enter moves on to adding the next subtask instead of submitting the form.
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        newInputRef.current?.focus();
                      }
                    }}
                  />
                  {errors[subtask.id] && (
                    <p id={errorId} className="field-error" role="alert">
                      {t(`validation.${errors[subtask.id]}`)}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger"
                  aria-label={t('subtasks.delete', { title: name })}
                  title={t('actions.delete')}
                  onClick={() => remove(subtask.id)}
                >
                  <TrashIcon size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {full ? (
        <p className="field-hint">{t('subtasks.limit', { count: SUBTASK_LIMIT })}</p>
      ) : (
        <div className="subtasks__add">
          <input
            id={newId}
            ref={newInputRef}
            className={`field-input subtasks__new${errors.new ? ' has-error' : ''}`}
            value={draft}
            maxLength={SUBTASK_TITLE_LIMIT}
            placeholder={t('subtasks.placeholder')}
            aria-label={t('subtasks.new')}
            aria-invalid={Boolean(errors.new)}
            aria-describedby={errors.new ? `${newId}-error` : undefined}
            onChange={(event) => {
              onDraftChange(event.target.value);
              clearError('new');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn--sm btn--ghost" onClick={add}>
            <PlusIcon size={14} />
            {t('subtasks.add')}
          </button>
          {errors.new && (
            <p id={`${newId}-error`} className="field-error subtasks__add-error" role="alert">
              {t(`validation.${errors.new}`)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
