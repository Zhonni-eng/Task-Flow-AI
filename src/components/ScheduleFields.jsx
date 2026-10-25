import { useId } from 'react';
import { DAY_MINUTES, MAX_ESTIMATE_MINUTES, MAX_RECURRENCE_INTERVAL, RECURRENCE_FREQUENCIES, isDateKey } from '../../electron/shared/schedule.mjs';
import { reminderLabel } from '../data/scheduleText.js';
import { useI18n } from '../i18n/I18nProvider.jsx';

// Reminder choices: minute offsets need a due time; without one, reminders are whole days.
const TIMED_OFFSETS = [0, 10, 30, 60, DAY_MINUTES];
const DAY_OFFSETS = [0, DAY_MINUTES, 2 * DAY_MINUTES, 7 * DAY_MINUTES];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

const dayOfWeek = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

/**
 * Due time, reminders, repeat rule and estimate of a task (task form). Everything except the
 * estimate depends on the due date; without one these fields are disabled and say why.
 * `values`: the form values; `onChange(field, value)`.
 */
export default function ScheduleFields({ values, onChange }) {
  const { t } = useI18n();
  const ids = { time: useId(), estimate: useId(), reminders: useId(), repeat: useId(), interval: useId(), hint: useId() };
  const hasDate = isDateKey(values.dueDate);
  const timed = hasDate && Boolean(values.dueTime);
  const offsets = timed ? TIMED_OFFSETS : DAY_OFFSETS;
  const rule = values.recurrence;
  const describedBy = hasDate ? undefined : ids.hint;

  const toggleReminder = (offset) => {
    const list = values.reminders.includes(offset) ? values.reminders.filter((item) => item !== offset) : [...values.reminders, offset];
    onChange('reminders', list.sort((a, b) => a - b));
  };
  const setFrequency = (freq) => {
    if (!freq) return onChange('recurrence', null);
    const next = { freq, interval: rule?.interval ?? 1 };
    if (freq === 'weekly') next.weekdays = rule?.weekdays?.length ? rule.weekdays : [dayOfWeek(values.dueDate)];
    if (freq === 'monthly') next.monthDay = rule?.monthDay ?? Number(values.dueDate.slice(8, 10));
    return onChange('recurrence', next);
  };
  const toggleWeekday = (day) => {
    const days = rule.weekdays.includes(day) ? rule.weekdays.filter((item) => item !== day) : [...rule.weekdays, day];
    // At least one day stays selected.
    if (days.length > 0) onChange('recurrence', { ...rule, weekdays: days.sort() });
  };

  return (
    <fieldset className="field schedule-fields">
      <legend className="field-label">{t('schedule.title')}</legend>
      {!hasDate && (
        <p id={ids.hint} className="field-hint">
          {t('schedule.needsDate')}
        </p>
      )}

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={ids.time}>
            {t('schedule.dueTime')}
            <span className="field-label__optional">{t('taskForm.optional')}</span>
          </label>
          <input
            id={ids.time}
            type="time"
            className="field-input"
            value={hasDate ? values.dueTime ?? '' : ''}
            disabled={!hasDate}
            aria-describedby={describedBy}
            onChange={(event) => onChange('dueTime', event.target.value || null)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={ids.estimate}>
            {t('schedule.estimate')}
            <span className="field-label__optional">{t('taskForm.optional')}</span>
          </label>
          <input
            id={ids.estimate}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_ESTIMATE_MINUTES}
            step={5}
            className="field-input"
            value={values.estimateMinutes ?? ''}
            onChange={(event) => {
              const minutes = Number.parseInt(event.target.value, 10);
              onChange('estimateMinutes', Number.isInteger(minutes) && minutes > 0 ? Math.min(minutes, MAX_ESTIMATE_MINUTES) : null);
            }}
          />
        </div>
      </div>

      <div className="field" role="group" aria-labelledby={ids.reminders}>
        <span id={ids.reminders} className="field-label">
          {t('schedule.reminders')}
        </span>
        <div className="chip-options">
          {offsets.map((offset) => (
            <label key={offset} className={`chip-option${!hasDate ? ' is-disabled' : ''}`}>
              <input
                type="checkbox"
                checked={hasDate && values.reminders.includes(offset)}
                disabled={!hasDate}
                aria-describedby={describedBy}
                onChange={() => toggleReminder(offset)}
              />
              <span>{reminderLabel(t, offset, timed)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={ids.repeat}>
            {t('schedule.repeat')}
          </label>
          <select
            id={ids.repeat}
            className="field-input field-input--select"
            value={hasDate ? rule?.freq ?? '' : ''}
            disabled={!hasDate}
            aria-describedby={describedBy}
            onChange={(event) => setFrequency(event.target.value)}
          >
            <option value="">{t('schedule.noRepeat')}</option>
            {RECURRENCE_FREQUENCIES.map((freq) => (
              <option key={freq} value={freq}>
                {t(`schedule.freq.${freq}`)}
              </option>
            ))}
          </select>
        </div>
        {hasDate && rule && (
          <div className="field">
            <label className="field-label" htmlFor={ids.interval}>
              {t(`schedule.interval.${rule.freq}`)}
            </label>
            <input
              id={ids.interval}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_RECURRENCE_INTERVAL}
              className="field-input"
              value={rule.interval}
              onChange={(event) => {
                const interval = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(interval) && interval >= 1) onChange('recurrence', { ...rule, interval: Math.min(interval, MAX_RECURRENCE_INTERVAL) });
              }}
            />
          </div>
        )}
      </div>
      {hasDate && rule?.freq === 'weekly' && (
        <div className="chip-options" role="group" aria-label={t('schedule.weekdaysLabel')}>
          {WEEK_ORDER.map((day) => (
            <label key={day} className="chip-option">
              <input type="checkbox" checked={rule.weekdays.includes(day)} onChange={() => toggleWeekday(day)} />
              <span>{t(`schedule.weekdays.${day}`)}</span>
            </label>
          ))}
        </div>
      )}
      {hasDate && rule?.freq === 'monthly' && <p className="field-hint">{t('schedule.monthlyHint', { day: rule.monthDay })}</p>}
      {hasDate && rule && <p className="field-hint">{t('schedule.repeatHint')}</p>}
      {values.planned && (
        <p className="field-hint schedule-fields__planned">
          {t('schedule.plannedInfo', { date: values.planned.date, time: values.planned.time })}{' '}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange('planned', null)}>
            {t('schedule.removePlan')}
          </button>
        </p>
      )}
    </fieldset>
  );
}
