import { useId, useState } from 'react';
import { CATEGORY_NAME_LIMIT } from '../data/categoryModel.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { CloseIcon } from './Icons.jsx';
import Modal from './Modal.jsx';

/**
 * Create or rename a category. `onSubmit(name)` returns an error code
 * ('required' | 'duplicate') or null on success.
 */
export default function CategoryNameDialog({ initialName = '', onSubmit, onCancel }) {
  const { t } = useI18n();
  const isRename = Boolean(initialName);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState(null);
  const headingId = useId();
  const inputId = useId();
  const errorId = useId();

  const handleSubmit = (event) => {
    event.preventDefault();
    if (isRename && name.trim() === initialName) {
      onCancel();
      return;
    }
    const result = onSubmit(name);
    if (result) setError(result);
  };

  return (
    <Modal onClose={onCancel} labelledBy={headingId} size="sm">
      <form noValidate onSubmit={handleSubmit}>
        <header className="modal__header">
          <h2 id={headingId} className="modal__title">
            {isRename ? t('categories.renameTitle') : t('categories.createTitle')}
          </h2>
          <button type="button" className="icon-btn" aria-label={t('actions.close')} title={t('actions.close')} onClick={onCancel}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="modal__body">
          <div className="field">
            <label className="field-label" htmlFor={inputId}>
              {t('categories.nameLabel')}
            </label>
            <input
              id={inputId}
              data-autofocus
              className={`field-input${error ? ' has-error' : ''}`}
              value={name}
              maxLength={CATEGORY_NAME_LIMIT}
              placeholder={t('categories.namePlaceholder')}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id={errorId} className="field-error" role="alert">
                {t(`categories.errors.${error}`)}
              </p>
            )}
          </div>
        </div>
        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {t('actions.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {isRename ? t('actions.save') : t('categories.create')}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
