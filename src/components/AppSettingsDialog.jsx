import { useId, useState } from 'react';
import { saveAvailability, saveReminderSettings } from '../storage/storage.js';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { CloseIcon } from './Icons.jsx';
import Modal from './Modal.jsx';

/**
 * App settings: desktop reminders (on/off, the time reminders of tasks without a due time fire)
 * and the planning availability the assistant's day plans must fit into. Saved with the other
 * settings (validated again by the main process).
 * `reminders`: { enabled, allDayTime }; `availability`: { start, end } | null.
 */
export default function AppSettingsDialog({ reminders, availability, onChange, onClose }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(reminders.enabled);
  const [allDayTime, setAllDayTime] = useState(reminders.allDayTime);
  const [start, setStart] = useState(availability?.start ?? '');
  const [end, setEnd] = useState(availability?.end ?? '');
  const [error, setError] = useState(null);
  const ids = { heading: useId(), enabled: useId(), allDay: useId(), start: useId(), end: useId(), error: useId() };

  const save = (event) => {
    event.preventDefault();
    if (!allDayTime) {
      setError('allDayTimeRequired');
      return;
    }
    let nextAvailability = null;
    if (start || end) {
      if (!start || !end || start >= end) {
        setError('availabilityInvalid');
        return;
      }
      nextAvailability = { start, end };
    }
    const nextReminders = { enabled, allDayTime };
    saveReminderSettings(nextReminders);
    saveAvailability(nextAvailability);
    onChange({ reminders: nextReminders, availability: nextAvailability });
    onClose();
  };

  return (
    <Modal onClose={onClose} labelledBy={ids.heading} size="sm">
      <form noValidate onSubmit={save}>
        <header className="modal__header">
          <h2 id={ids.heading} className="modal__title">
            {t('appSettings.title')}
          </h2>
          <button type="button" className="icon-btn" aria-label={t('actions.close')} title={t('actions.close')} onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="modal__body">
          <fieldset className="field">
            <legend className="field-label">{t('appSettings.reminders')}</legend>
            <label className="ai-settings__switch" htmlFor={ids.enabled}>
              <input id={ids.enabled} type="checkbox" data-autofocus checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              <span>{t('appSettings.remindersEnabled')}</span>
            </label>
            <label className="field-label" htmlFor={ids.allDay}>
              {t('appSettings.allDayTime')}
            </label>
            <input id={ids.allDay} type="time" className="field-input" value={allDayTime} onChange={(event) => setAllDayTime(event.target.value)} />
            <p className="field-hint">{t('appSettings.remindersHint')}</p>
          </fieldset>

          <fieldset className="field">
            <legend className="field-label">{t('appSettings.availability')}</legend>
            <div className="field-row">
              <div className="field">
                <label className="field-label" htmlFor={ids.start}>
                  {t('appSettings.availableFrom')}
                </label>
                <input id={ids.start} type="time" className="field-input" value={start} onChange={(event) => setStart(event.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={ids.end}>
                  {t('appSettings.availableUntil')}
                </label>
                <input id={ids.end} type="time" className="field-input" value={end} onChange={(event) => setEnd(event.target.value)} />
              </div>
            </div>
            <p className="field-hint">{t('appSettings.availabilityHint')}</p>
          </fieldset>
          {error && (
            <p id={ids.error} className="field-error" role="alert">
              {t(`appSettings.errors.${error}`)}
            </p>
          )}
        </div>
        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {t('actions.save')}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
