import { useId, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { TrashIcon } from './Icons.jsx';
import Modal from './Modal.jsx';

/**
 * Confirms deleting a category. Tasks are never deleted: they move to
 * "Uncategorized" or to another category chosen here.
 * `onConfirm(targetCategoryId | null)`.
 */
export default function CategoryDeleteDialog({ category, taskCount, otherCategories, onConfirm, onCancel }) {
  const { t } = useI18n();
  const titleId = useId();
  const messageId = useId();
  const [target, setTarget] = useState('none');
  const [otherId, setOtherId] = useState(otherCategories[0]?.id ?? '');

  return (
    <Modal onClose={onCancel} labelledBy={titleId} describedBy={messageId} size="sm" role="alertdialog">
      <div className="confirm">
        <span className="confirm__icon" aria-hidden="true">
          <TrashIcon size={22} />
        </span>
        <h2 id={titleId} className="confirm__title">
          {t('categories.deleteTitle', { name: category.name })}
        </h2>
        <p id={messageId} className="confirm__message">
          {taskCount > 0 ? t('categories.deleteHasTasks', { count: taskCount }) : t('categories.deleteEmpty')}
        </p>
      </div>

      {taskCount > 0 && (
        <fieldset className="delete-options">
          <legend className="visually-hidden">{t('categories.deleteChoice')}</legend>
          <label className="delete-options__option">
            <input type="radio" name={titleId} checked={target === 'none'} onChange={() => setTarget('none')} />
            <span>{t('categories.moveToUncategorized')}</span>
          </label>
          {otherCategories.length > 0 && (
            <label className="delete-options__option">
              <input type="radio" name={titleId} checked={target === 'other'} onChange={() => setTarget('other')} />
              <span>{t('categories.moveToCategory')}</span>
              <select
                className="field-input delete-options__select"
                value={otherId}
                aria-label={t('categories.targetCategory')}
                onChange={(event) => {
                  setOtherId(event.target.value);
                  setTarget('other');
                }}
              >
                {otherCategories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      )}

      <footer className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onCancel} data-autofocus>
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => onConfirm(target === 'other' && otherId ? otherId : null)}
        >
          {t('categories.deleteConfirm')}
        </button>
      </footer>
    </Modal>
  );
}
