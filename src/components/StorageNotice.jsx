import { useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { getSaveStatus, retrySave } from '../storage/storage.js';
import { AlertIcon, CloseIcon } from './Icons.jsx';

// Startup outcomes that need the user's attention. `persistent` notices cannot be dismissed.
const BOOT_NOTICES = {
  recovered: { key: 'storage.recovered', tone: 'warning' },
  unreadable: { key: 'storage.unreadable', tone: 'warning' },
  repaired: { key: 'storage.repaired', tone: 'warning' },
  'newer-version': { key: 'storage.newerVersion', tone: 'error', persistent: true },
  'read-error': { key: 'storage.readError', tone: 'error', persistent: true },
  unavailable: { key: 'storage.unavailable', tone: 'warning', persistent: true },
};

const fileName = (fullPath) => (fullPath ? fullPath.split(/[\\/]/).pop() : null);

// When the notice disappears while it holds keyboard focus, focus moves here instead of being lost.
const focusFallback = () => document.querySelector('[data-focus-target="new-task"]')?.focus();

export default function StorageNotice({ boot, saveStatus }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const rootRef = useRef(null);
  const holdsFocus = () => Boolean(rootRef.current?.contains(document.activeElement));

  if (!saveStatus.ok) {
    const retry = async () => {
      if (retrying) return;
      const hadFocus = holdsFocus();
      setRetrying(true);
      await retrySave();
      setRetrying(false);
      // A successful retry removes this notice (and the focused button with it).
      if (hadFocus && getSaveStatus().ok && (document.activeElement === document.body || holdsFocus())) focusFallback();
    };
    return (
      <div className="notice notice--error" role="alert" ref={rootRef}>
        <AlertIcon size={18} className="notice__icon" />
        <div className="notice__text">
          <p className="notice__title">{t('storage.saveFailed')}</p>
          <p className="notice__detail">{t('storage.saveFailedDetail')}</p>
        </div>
        {/* aria-disabled (not disabled) keeps keyboard focus on the button while retrying. */}
        <button type="button" className="btn btn--sm btn--ghost" onClick={retry} aria-disabled={retrying || undefined}>
          {t('storage.retry')}
        </button>
      </div>
    );
  }

  const notice = BOOT_NOTICES[boot.status];
  if (!notice || dismissed) return null;
  const copy = fileName(boot.preservedCopy);

  return (
    <div className={`notice notice--${notice.tone}`} role="status" ref={rootRef}>
      <AlertIcon size={18} className="notice__icon" />
      <div className="notice__text">
        <p className="notice__title">{t(notice.key)}</p>
        {copy && <p className="notice__detail">{t('storage.copySaved', { file: copy })}</p>}
      </div>
      {!notice.persistent && (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label={t('storage.dismiss')}
          title={t('storage.dismiss')}
          onClick={() => {
            if (holdsFocus()) focusFallback();
            setDismissed(true);
          }}
        >
          <CloseIcon size={14} />
        </button>
      )}
    </div>
  );
}
