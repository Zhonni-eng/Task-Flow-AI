import { useId } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { TrashIcon } from './Icons.jsx';
import Modal from './Modal.jsx';

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, icon, onConfirm, onCancel }) {
  const { t } = useI18n();
  const titleId = useId();
  const messageId = useId();

  return (
    <Modal onClose={onCancel} labelledBy={titleId} describedBy={messageId} size="sm" role="alertdialog">
      <div className="confirm">
        <span className="confirm__icon" aria-hidden="true">
          {icon ?? <TrashIcon size={22} />}
        </span>
        <h2 id={titleId} className="confirm__title">
          {title}
        </h2>
        <p id={messageId} className="confirm__message">
          {message}
        </p>
      </div>
      <footer className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onCancel} data-autofocus>
          {cancelLabel ?? t('actions.cancel')}
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}
