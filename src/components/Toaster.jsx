import { useI18n } from '../i18n/I18nProvider.jsx';
import { AlertIcon, CheckCircleIcon, CloseIcon } from './Icons.jsx';

// Polite live region with confirmation messages. Only the close buttons take pointer
// input, so toasts never block the board underneath.
export default function Toaster({ toasts, onDismiss }) {
  const { t } = useI18n();

  return (
    <div className="toaster" role="status" aria-live="polite" aria-label={t('toast.region')}>
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          {toast.tone === 'error' ? <AlertIcon size={18} className="toast__icon" /> : <CheckCircleIcon size={18} className="toast__icon" />}
          <p className="toast__message">{toast.message}</p>
          <button
            type="button"
            className="icon-btn icon-btn--sm toast__close"
            aria-label={t('toast.dismiss')}
            title={t('toast.dismiss')}
            onClick={() => onDismiss(toast.id)}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
