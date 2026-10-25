import { useI18n } from '../i18n/I18nProvider.jsx';
import { LIMITS, normalizeLabels, splitLabels } from '../data/taskModel.js';
import { labelColor } from '../utils/labelColor.js';
import { CloseIcon, PlusIcon } from './Icons.jsx';

// Chip-style label editor. The text being typed (`draft`) is owned by the parent
// so that an uncommitted label is still saved when the form is submitted.
export default function LabelInput({ id, labels, onChange, draft, onDraftChange, suggestions, describedBy }) {
  const { t } = useI18n();
  const full = labels.length >= LIMITS.labels;

  const commit = (text) => {
    const next = normalizeLabels([...labels, ...splitLabels(text)]);
    if (next.length !== labels.length) onChange(next);
    onDraftChange('');
  };

  const remove = (label) => onChange(labels.filter((item) => item !== label));

  const handleKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (event.key === 'Backspace' && !draft && labels.length > 0) {
      remove(labels[labels.length - 1]);
    }
  };

  const handleChange = (event) => {
    const text = event.target.value;
    if (text.includes(',')) commit(text);
    else onDraftChange(text);
  };

  const taken = new Set(labels.map((label) => label.toLocaleLowerCase()));
  const available = full ? [] : suggestions.filter((label) => !taken.has(label.toLocaleLowerCase())).slice(0, 8);

  return (
    <div className="label-input">
      <div className="field-input label-input__box">
        {labels.map((label) => (
          <span key={label} className="label label--chip" style={{ '--label-color': labelColor(label) }}>
            {label}
            <button
              type="button"
              className="label__remove"
              aria-label={t('taskForm.removeLabel', { label })}
              title={t('taskForm.removeLabel', { label })}
              onClick={() => remove(label)}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        ))}
        {!full && (
          <input
            id={id}
            className="label-input__text"
            value={draft}
            maxLength={LIMITS.label}
            placeholder={labels.length === 0 ? t('taskForm.labelsPlaceholder') : ''}
            aria-describedby={describedBy}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => draft.trim() && commit(draft)}
          />
        )}
      </div>

      {available.length > 0 && (
        <div className="label-input__suggestions">
          <span className="label-input__suggestions-title">{t('taskForm.labelsSuggestions')}</span>
          {available.map((label) => (
            <button
              key={label}
              type="button"
              className="label label--suggestion"
              style={{ '--label-color': labelColor(label) }}
              onClick={() => onChange(normalizeLabels([...labels, label]))}
            >
              <PlusIcon size={11} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
