import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider.jsx';
import {
  addDays,
  addMonths,
  isSameDay,
  parseDateKey,
  QUICK_DATES,
  quickDate,
  startOfMonth,
  startOfToday,
  toDateKey,
} from '../utils/date.js';
import { CalendarIcon, ChevronIcon, CloseIcon } from './Icons.jsx';

const capitalize = (text) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

// Localized date picker. The native <input type="date"> follows the OS locale,
// not the in-app language, so the calendar is rendered here with Intl.
// Optional: `triggerLabel` replaces the trigger text (used as an action button, e.g. bulk
// due date), `triggerClassName` replaces its field styling, `placement="top"` opens upward.
export default function DatePicker({ id, value, onChange, labelledBy, triggerLabel, triggerClassName, placement = 'bottom' }) {
  const { t, locale, weekStart, formatDate } = useI18n();
  const selected = parseDateKey(value);
  const today = startOfToday();

  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => startOfMonth(selected ?? today));
  // Roving focus inside the day grid (arrow keys, PageUp/PageDown, Home/End).
  const [focusDate, setFocusDate] = useState(() => selected ?? today);
  const moveFocusRef = useRef(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!open || !moveFocusRef.current) return;
    moveFocusRef.current = false;
    popoverRef.current?.querySelector(`[data-date="${toDateKey(focusDate)}"]`)?.focus();
  }, [open, focusDate, view]);

  useEffect(() => {
    if (!open) return undefined;
    popoverRef.current?.scrollIntoView({ block: 'nearest' });
    const handlePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [open]);

  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    // 2024-01-07 is a Sunday.
    return Array.from({ length: 7 }, (_, i) =>
      capitalize(format.format(new Date(2024, 0, 7 + ((weekStart + i) % 7)))),
    );
  }, [locale, weekStart]);

  const days = useMemo(() => {
    const offset = (view.getDay() - weekStart + 7) % 7;
    const first = addDays(view, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [view, weekStart]);

  const monthTitle = `${capitalize(formatDate(view, { month: 'long' }))} ${view.getFullYear()}`;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const toggle = () => {
    if (!open) {
      const start = selected ?? today;
      setView(startOfMonth(start));
      setFocusDate(start);
      moveFocusRef.current = true;
    }
    setOpen(!open);
  };

  const focusDay = (date) => {
    setFocusDate(date);
    if (date.getMonth() !== view.getMonth() || date.getFullYear() !== view.getFullYear()) setView(startOfMonth(date));
    moveFocusRef.current = true;
  };

  const shiftMonth = (date, months) => {
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
  };

  const handleGridKey = (event) => {
    const weekOffset = (focusDate.getDay() - weekStart + 7) % 7;
    const moves = {
      ArrowLeft: () => addDays(focusDate, -1),
      ArrowRight: () => addDays(focusDate, 1),
      ArrowUp: () => addDays(focusDate, -7),
      ArrowDown: () => addDays(focusDate, 7),
      PageUp: () => shiftMonth(focusDate, -1),
      PageDown: () => shiftMonth(focusDate, 1),
      Home: () => addDays(focusDate, -weekOffset),
      End: () => addDays(focusDate, 6 - weekOffset),
    };
    if (!moves[event.key]) return;
    event.preventDefault();
    focusDay(moves[event.key]());
  };

  // When the month changes with the arrow buttons, keep a tabbable day in that month.
  const changeMonth = (months) => {
    const nextView = addMonths(view, months);
    setView(nextView);
    setFocusDate(shiftMonth(focusDate, months));
  };

  const pick = (date) => {
    onChange(date ? toDateKey(date) : null);
    close();
  };

  return (
    <div
      className="date-picker"
      ref={rootRef}
      onBlur={(event) => {
        // Tabbing out of the calendar closes it (mouse clicks outside are handled on mousedown).
        if (open && event.relatedTarget && !rootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          // Close only the calendar, not the surrounding dialog.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="date-picker__control">
        <button
          id={id}
          ref={triggerRef}
          type="button"
          className={triggerClassName ?? `field-input date-picker__trigger${selected ? '' : ' is-empty'}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={labelledBy ? `${labelledBy} ${id}` : undefined}
          onClick={toggle}
        >
          <CalendarIcon size={16} />
          <span>
            {triggerLabel ??
              (selected ? formatDate(selected, { day: 'numeric', month: 'long', year: 'numeric' }) : t('datePicker.noDate'))}
          </span>
        </button>
        {selected && !triggerLabel && (
          <button
            type="button"
            className="icon-btn date-picker__clear"
            aria-label={t('datePicker.clear')}
            title={t('datePicker.clear')}
            onClick={() => onChange(null)}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className={`date-picker__popover${placement === 'top' ? ' date-picker__popover--top' : ''}`} ref={popoverRef} role="dialog" aria-label={t('datePicker.choose')}>
          <div className="date-picker__header">
            <button
              type="button"
              className="icon-btn"
              aria-label={t('datePicker.prevMonth')}
              title={t('datePicker.prevMonth')}
              onClick={() => changeMonth(-1)}
            >
              <ChevronIcon size={16} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <span className="date-picker__month" aria-live="polite">
              {monthTitle}
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('datePicker.nextMonth')}
              title={t('datePicker.nextMonth')}
              onClick={() => changeMonth(1)}
            >
              <ChevronIcon size={16} />
            </button>
          </div>

          <div className="date-picker__grid" role="grid" aria-label={monthTitle} onKeyDown={handleGridKey}>
            {weekdays.map((name) => (
              <span key={name} className="date-picker__weekday" role="columnheader">
                {name}
              </span>
            ))}
            {days.map((day) => {
              const classes = ['date-picker__day'];
              if (day.getMonth() !== view.getMonth()) classes.push('is-outside');
              if (isSameDay(day, today)) classes.push('is-today');
              if (isSameDay(day, selected)) classes.push('is-selected');
              return (
                <button
                  key={day.getTime()}
                  type="button"
                  data-date={toDateKey(day)}
                  tabIndex={isSameDay(day, focusDate) ? 0 : -1}
                  className={classes.join(' ')}
                  aria-pressed={isSameDay(day, selected)}
                  aria-label={formatDate(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  onClick={() => pick(day)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          {/* Quick choices: the same local-date rules wherever a due date is picked. */}
          <div className="date-picker__footer" role="group" aria-label={t('datePicker.quick')}>
            {QUICK_DATES.map((kind) => {
              const date = quickDate(kind, today, weekStart);
              const name = t(`datePicker.${kind}`);
              const isCurrent = isSameDay(date, selected);
              const label = t('datePicker.quickOption', { name, date: formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' }) });
              return (
                <button
                  key={kind}
                  type="button"
                  className={`btn btn--ghost btn--sm date-picker__quick${isCurrent ? ' is-selected' : ''}`}
                  aria-label={label}
                  title={label}
                  aria-pressed={isCurrent}
                  onClick={() => pick(date)}
                >
                  <span>{name}</span>
                  <span className="date-picker__quick-date">{formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                </button>
              );
            })}
            <button type="button" className="btn btn--ghost btn--sm date-picker__no-date" onClick={() => pick(null)}>
              {t('datePicker.noDate')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
