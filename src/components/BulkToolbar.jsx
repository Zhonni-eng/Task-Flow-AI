import { useId } from 'react';
import { COLUMNS } from '../data/board.js';
import { PRIORITIES } from '../data/taskModel.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import DatePicker from './DatePicker.jsx';
import { CheckCircleIcon, CloseIcon, TrashIcon } from './Icons.jsx';

export const UNCATEGORIZED_OPTION = '__none__';

/** A select used as an action menu: picking an option runs the action, then it resets. */
function ActionSelect({ label, placeholder, options, onPick }) {
  return (
    <select
      className="bulk-toolbar__select"
      value=""
      aria-label={label}
      title={label}
      onChange={(event) => {
        if (event.target.value) onPick(event.target.value);
      }}
    >
      <option value="" disabled hidden>
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Contextual actions for the List View selection. Shown only when at least one task is
 * selected; every action applies to exactly the selected (visible) tasks.
 */
export default function BulkToolbar({ count, categories, onComplete, onStatus, onCategory, onPriority, onDueDate, onDelete, onClear }) {
  const { t } = useI18n();
  const dateId = useId();

  return (
    <div className="bulk-toolbar" role="toolbar" aria-label={t('bulk.toolbar')}>
      <span className="bulk-toolbar__count" aria-live="polite">
        {t('bulk.selected', { count })}
      </span>

      <button type="button" className="btn btn--sm btn--primary" onClick={onComplete}>
        <CheckCircleIcon size={15} />
        {t('bulk.markDone')}
      </button>

      <ActionSelect
        label={t('bulk.statusLabel')}
        placeholder={t('bulk.status')}
        options={COLUMNS.map((column) => ({ value: column.id, label: t(column.titleKey) }))}
        onPick={onStatus}
      />
      <ActionSelect
        label={t('bulk.categoryLabel')}
        placeholder={t('bulk.category')}
        options={[
          { value: UNCATEGORIZED_OPTION, label: t('nav.uncategorized') },
          ...categories.map((category) => ({ value: category.id, label: category.name })),
        ]}
        onPick={(value) => onCategory(value === UNCATEGORIZED_OPTION ? null : value)}
      />
      <ActionSelect
        label={t('bulk.priorityLabel')}
        placeholder={t('bulk.priority')}
        options={[...PRIORITIES].reverse().map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))}
        onPick={onPriority}
      />
      <DatePicker
        id={dateId}
        value={null}
        onChange={onDueDate}
        triggerLabel={t('bulk.dueDate')}
        triggerClassName="bulk-toolbar__select bulk-toolbar__date"
        placement="top"
      />

      <button type="button" className="btn btn--sm btn--danger-ghost" onClick={onDelete}>
        <TrashIcon size={15} />
        {t('bulk.delete')}
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm bulk-toolbar__clear"
        aria-label={t('bulk.clear')}
        title={t('bulk.clear')}
        onClick={onClear}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
