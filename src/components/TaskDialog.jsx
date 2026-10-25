import { useId, useRef, useState } from 'react';
import { createSubtask, validateSubtaskTitle } from '../data/subtasks.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import {
  LIMITS,
  PRIORITIES,
  normalizeLabels,
  splitLabels,
  toFormValues,
  validateTaskFields,
} from '../data/taskModel.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import DatePicker from './DatePicker.jsx';
import { AlertIcon, CloseIcon, TrashIcon } from './Icons.jsx';
import LabelInput from './LabelInput.jsx';
import ScheduleFields from './ScheduleFields.jsx';
import SubtaskEditor from './SubtaskEditor.jsx';
import Modal from './Modal.jsx';

// Create / edit dialog. `task` is null when creating.
// `defaultCategoryId` preselects the category when creating from a category view.
export default function TaskDialog({ task, categories, defaultCategoryId = null, labelSuggestions, onSubmit, onCancel, onDelete }) {
  const { t } = useI18n();
  const isEdit = Boolean(task);
  const [initialValues] = useState(() => (task ? toFormValues(task) : { ...toFormValues(null), categoryId: defaultCategoryId }));
  const [values, setValues] = useState(initialValues);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [subtaskErrors, setSubtaskErrors] = useState({});
  const [errors, setErrors] = useState({});
  const titleRef = useRef(null);

  const ids = {
    heading: useId(),
    title: useId(),
    titleError: useId(),
    description: useId(),
    priority: useId(),
    due: useId(),
    dueLabel: useId(),
    labels: useId(),
    labelsHint: useId(),
    category: useId(),
  };

  const setField = (field) => (value) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    // A subtask typed into the "new subtask" field but not added yet is kept, like labels.
    const subtasks = subtaskDraft.trim() ? [...values.subtasks, createSubtask(subtaskDraft)] : values.subtasks;
    const fields = {
      ...values,
      labels: normalizeLabels([...values.labels, ...splitLabels(labelDraft)]),
      subtasks,
    };
    const validation = validateTaskFields(fields);
    // Subtask titles must not be empty; nothing is dropped silently.
    const invalidSubtasks = Object.fromEntries(
      subtasks.filter((subtask) => validateSubtaskTitle(subtask.title)).map((subtask) => [subtask.id, 'subtaskRequired']),
    );
    if (Object.keys(validation).length > 0 || Object.keys(invalidSubtasks).length > 0) {
      setErrors(validation);
      setSubtaskErrors(invalidSubtasks);
      if (validation.title) titleRef.current?.focus();
      else document.querySelector(`[data-subtask-id="${Object.keys(invalidSubtasks)[0]}"]`)?.focus();
      return;
    }
    onSubmit(fields);
  };

  const isDirty =
    JSON.stringify(values) !== JSON.stringify(initialValues) || labelDraft.trim() !== '' || subtaskDraft.trim() !== '';
  // Escape and backdrop clicks are easy to trigger by accident: ask before losing edits.
  // The explicit Cancel and close buttons discard immediately.
  const handleDismiss = () => (isDirty ? setConfirmDiscard(true) : onCancel());

  return (
    <Modal onClose={handleDismiss} labelledBy={ids.heading}>
      <form className="task-form" noValidate onSubmit={handleSubmit}>
        <header className="modal__header">
          <div>
            <h2 id={ids.heading} className="modal__title">
              {isEdit ? t('taskForm.editTitle') : t('taskForm.createTitle')}
            </h2>
            <p className="modal__subtitle">
              {isEdit ? t('taskForm.editSubtitle') : t('taskForm.createSubtitle', { column: t('columns.todo') })}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('actions.close')}
            title={t('actions.close')}
            onClick={onCancel}
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="modal__body">
          <div className="field">
            <label className="field-label" htmlFor={ids.title}>
              {t('taskForm.title')}
              <span className="field-label__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={ids.title}
              ref={titleRef}
              data-autofocus
              className={`field-input${errors.title ? ' has-error' : ''}`}
              value={values.title}
              maxLength={LIMITS.title}
              placeholder={t('taskForm.titlePlaceholder')}
              aria-required="true"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? ids.titleError : undefined}
              onChange={(event) => setField('title')(event.target.value)}
            />
            {errors.title && (
              <p id={ids.titleError} className="field-error" role="alert">
                {t(`validation.${errors.title}`)}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor={ids.description}>
              {t('taskForm.description')}
              <span className="field-label__optional">{t('taskForm.optional')}</span>
            </label>
            <textarea
              id={ids.description}
              className="field-input field-input--textarea"
              rows={4}
              value={values.description}
              maxLength={LIMITS.description}
              placeholder={t('taskForm.descriptionPlaceholder')}
              onChange={(event) => setField('description')(event.target.value)}
            />
          </div>

          <div className="field-row">
            <fieldset className="field">
              <legend className="field-label">{t('priority.label')}</legend>
              <div className="segmented">
                {PRIORITIES.map((priority) => (
                  <label key={priority} className={`segmented__option segmented__option--${priority}`}>
                    <input
                      type="radio"
                      name={ids.priority}
                      value={priority}
                      checked={values.priority === priority}
                      onChange={() => setField('priority')(priority)}
                    />
                    <span>
                      <span className="priority__dot" aria-hidden="true" />
                      {t(`priority.${priority}`)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="field">
              <span id={ids.dueLabel} className="field-label">
                {t('taskForm.dueDate')}
              </span>
              <DatePicker
                id={ids.due}
                labelledBy={ids.dueLabel}
                value={values.dueDate}
                onChange={setField('dueDate')}
              />
            </div>
          </div>

          <ScheduleFields values={values} onChange={(field, value) => setField(field)(value)} />

          <div className="field">
            <label className="field-label" htmlFor={ids.category}>
              {t('taskForm.category')}
            </label>
            <select
              id={ids.category}
              className="field-input field-input--select"
              value={values.categoryId ?? ''}
              onChange={(event) => setField('categoryId')(event.target.value || null)}
            >
              <option value="">{t('nav.uncategorized')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={ids.labels}>
              {t('taskForm.labels')}
              <span className="field-label__optional">{t('taskForm.optional')}</span>
            </label>
            <LabelInput
              id={ids.labels}
              labels={values.labels}
              onChange={setField('labels')}
              draft={labelDraft}
              onDraftChange={setLabelDraft}
              suggestions={labelSuggestions}
              describedBy={ids.labelsHint}
            />
            <p id={ids.labelsHint} className="field-hint">
              {values.labels.length >= LIMITS.labels
                ? t('taskForm.labelsLimit', { count: LIMITS.labels })
                : t('taskForm.labelsHint')}
            </p>
          </div>

          <SubtaskEditor
            subtasks={values.subtasks}
            onChange={setField('subtasks')}
            draft={subtaskDraft}
            onDraftChange={setSubtaskDraft}
            errors={subtaskErrors}
            onErrorsChange={setSubtaskErrors}
          />
        </div>

        <footer className="modal__footer">
          {isEdit && (
            <button type="button" className="btn btn--danger-ghost modal__footer-start" onClick={onDelete}>
              <TrashIcon size={16} />
              {t('actions.delete')}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {t('actions.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {isEdit ? t('actions.save') : t('actions.createTask')}
          </button>
        </footer>
      </form>
      {confirmDiscard && (
        <ConfirmDialog
          title={t('discard.title')}
          message={t('discard.message')}
          confirmLabel={t('discard.confirm')}
          cancelLabel={t('discard.keepEditing')}
          icon={<AlertIcon size={22} />}
          onConfirm={onCancel}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Modal>
  );
}
