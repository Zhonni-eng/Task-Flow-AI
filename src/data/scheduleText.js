// Human-readable descriptions of reminder offsets and recurrence rules (renderer, via i18n).
import { DAY_MINUTES } from '../../electron/shared/schedule.mjs';

/** "At the due time" / "30 min before" / "1 day before" ... for a reminder offset. */
export function reminderLabel(t, offset, timed) {
  if (offset === 0) return t(timed ? 'schedule.reminderAtTime' : 'schedule.reminderOnDay');
  if (offset % (7 * DAY_MINUTES) === 0) return t('schedule.reminderWeeks', { count: offset / (7 * DAY_MINUTES) });
  if (offset % DAY_MINUTES === 0) return t('schedule.reminderDays', { count: offset / DAY_MINUTES });
  if (offset % 60 === 0) return t('schedule.reminderHours', { count: offset / 60 });
  return t('schedule.reminderMinutes', { count: offset });
}

/** "Every week on Mon, Thu" / "Every 2 days" / "Monthly on day 1" ... */
export function recurrenceLabel(t, rule) {
  if (!rule) return '';
  const every = rule.interval > 1 ? t(`schedule.every.${rule.freq}N`, { count: rule.interval }) : t(`schedule.every.${rule.freq}`);
  if (rule.freq === 'weekly') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => rule.weekdays?.includes(day)).map((day) => t(`schedule.weekdays.${day}`));
    return t('schedule.onDays', { rule: every, days: days.join(', ') });
  }
  if (rule.freq === 'monthly') return t('schedule.onMonthDay', { rule: every, day: rule.monthDay });
  return every;
}
