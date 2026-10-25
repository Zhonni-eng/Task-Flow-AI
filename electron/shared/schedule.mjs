// Deadlines, reminder schedules and recurrence rules - pure functions shared by the renderer
// (imported by Vite) and the Electron main process (required as an ES module).
//
// Three separate things:
//   - deadline:  task.dueDate ("YYYY-MM-DD", local calendar date) + optional task.dueTime ("HH:MM",
//                local wall-clock time). No time means "some time that day" - never a made-up time.
//   - reminders: task.reminders = minutes before the deadline. With a due time any offset works;
//                without one only whole days are allowed, and they fire at the user's "reminder time
//                for tasks without a time" (a reminder setting, not a deadline).
//   - recurrence: task.recurrence = a rule; the task always holds its NEXT occurrence in dueDate.
//
// Times are local wall-clock values and are turned into instants only when needed, with the
// current time zone. So a time-zone change moves nothing on the calendar ("09:00" stays 09:00), and
// DST is handled by the platform: a time that does not exist (spring forward) becomes the next
// valid time, an ambiguous one (fall back) is the first of the two.

export const DAY_MINUTES = 1440;
export const REMINDER_PRESETS = [0, 10, 30, 60, 120, DAY_MINUTES, 2 * DAY_MINUTES, 7 * DAY_MINUTES];
export const MAX_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 30 * DAY_MINUTES;
export const DEFAULT_ALL_DAY_REMINDER_TIME = '09:00';
export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'];
export const MAX_RECURRENCE_INTERVAL = 99;
export const MAX_ESTIMATE_MINUTES = 24 * 60;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_KEY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateKey(value) {
  const match = typeof value === 'string' ? DATE_KEY.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isTimeKey(value) {
  return typeof value === 'string' && TIME_KEY.test(value);
}

const pad = (value) => String(value).padStart(2, '0');
const parseDate = (key) => key.split('-').map(Number);
const keyOfUtc = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Local "YYYY-MM-DD" of an instant. */
export function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local "HH:MM" of an instant. */
export function localTimeKey(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant of a local date + wall-clock time in the current time zone. */
export function localInstant(dateKey, timeKey = '00:00') {
  const [year, month, day] = parseDate(dateKey);
  const [hours, minutes] = timeKey.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

/** Calendar arithmetic on date keys (no time zone involved). */
export function addDaysToKey(key, days) {
  const [year, month, day] = parseDate(key);
  return keyOfUtc(new Date(Date.UTC(year, month - 1, day + days)));
}

function daysBetween(fromKey, toKey) {
  const [y1, m1, d1] = parseDate(fromKey);
  const [y2, m2, d2] = parseDate(toKey);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const weekdayOf = (key) => {
  const [year, month, day] = parseDate(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
};
const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/** A due time only exists together with a due date. */
export function normalizeDueTime(value, dueDate) {
  return isDateKey(dueDate) && isTimeKey(value) ? value : null;
}

/**
 * Reminder offsets in minutes before the deadline: whole numbers, unique, sorted, at most
 * MAX_REMINDERS. Without a due date there are none; without a due time only whole days remain.
 */
export function normalizeReminders(list, dueDate, dueTime) {
  if (!Array.isArray(list) || !isDateKey(dueDate)) return [];
  const result = [];
  for (const value of list) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_MINUTES) continue;
    if (!isTimeKey(dueTime) && value % DAY_MINUTES !== 0) continue;
    if (!result.includes(value)) result.push(value);
  }
  return result.sort((a, b) => a - b).slice(0, MAX_REMINDERS);
}

/** Estimated duration in minutes (1..1440) or null. */
export function normalizeEstimate(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ESTIMATE_MINUTES ? value : null;
}

/**
 * Recurrence rule or null. { freq: 'daily'|'weekly'|'monthly', interval: 1..99,
 * weekdays: [0..6] (weekly, Sunday = 0; defaults to the due date's weekday),
 * monthDay: 1..31 (monthly; defaults to the due date's day; shorter months use their last day) }.
 * A rule needs a due date: the due date is the next occurrence.
 */
export function normalizeRecurrence(raw, dueDate) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isDateKey(dueDate)) return null;
  if (!RECURRENCE_FREQUENCIES.includes(raw.freq)) return null;
  const interval = Number.isInteger(raw.interval) && raw.interval >= 1 && raw.interval <= MAX_RECURRENCE_INTERVAL ? raw.interval : 1;
  const rule = { freq: raw.freq, interval };
  if (raw.freq === 'weekly') {
    const days = Array.isArray(raw.weekdays) ? [...new Set(raw.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
    rule.weekdays = days.length > 0 ? days : [weekdayOf(dueDate)];
  }
  if (raw.freq === 'monthly') {
    rule.monthDay = Number.isInteger(raw.monthDay) && raw.monthDay >= 1 && raw.monthDay <= 31 ? raw.monthDay : parseDate(dueDate)[2];
  }
  return rule;
}

/** Monday-based week number, for "every N weeks". */
const weekIndex = (key) => Math.floor(daysBetween('2000-01-03', key) / 7); // 2000-01-03 was a Monday

/**
 * The first occurrence of `rule` after `afterKey` (exclusive), stepping from `fromKey` (the current
 * occurrence, which keeps "every N" aligned). Returns a date key.
 */
export function nextOccurrence(rule, fromKey, afterKey) {
  const after = afterKey < fromKey ? fromKey : afterKey;
  if (rule.freq === 'daily') {
    const gap = daysBetween(fromKey, after);
    const steps = Math.floor(gap / rule.interval) + 1;
    return addDaysToKey(fromKey, steps * rule.interval);
  }
  if (rule.freq === 'weekly') {
    const baseWeek = weekIndex(fromKey);
    let key = addDaysToKey(after, 1);
    // Bounded: within interval * 7 days of any start there is an occurrence.
    for (let i = 0; i < rule.interval * 7 + 7; i += 1, key = addDaysToKey(key, 1)) {
      if ((weekIndex(key) - baseWeek) % rule.interval === 0 && rule.weekdays.includes(weekdayOf(key))) return key;
    }
    return addDaysToKey(after, 7 * rule.interval);
  }
  // monthly
  const [fromYear, fromMonth] = parseDate(fromKey);
  for (let step = 1; step < 12 * 200; step += 1) {
    const total = fromYear * 12 + (fromMonth - 1) + step * rule.interval;
    const year = Math.floor(total / 12);
    const month = total % 12;
    const key = `${year}-${pad(month + 1)}-${pad(Math.min(rule.monthDay, daysInMonth(year, month)))}`;
    if (key > after) return key;
  }
  return after;
}

/**
 * Completing an occurrence of a recurring task: the next due date. Missed occurrences are skipped
 * (an overdue series continues after today); completing early continues after the current one.
 */
export function nextDueDateAfterCompletion(rule, dueDate, todayKey) {
  return nextOccurrence(rule, dueDate, todayKey > dueDate ? todayKey : dueDate);
}

/**
 * The deadline instant for "is it overdue": the due time, or the end of the due day when there
 * is no time. null without a due date.
 */
export function deadlineInstant(task) {
  if (!isDateKey(task?.dueDate)) return null;
  if (isTimeKey(task.dueTime)) return localInstant(task.dueDate, task.dueTime);
  return localInstant(addDaysToKey(task.dueDate, 1), '00:00');
}

/**
 * When each reminder of a task fires: [{ offset, at: Date }]. With a due time, offsets count back
 * from it; without one, whole-day offsets count back from the due date at `allDayTime`.
 */
export function reminderSchedule(task, allDayTime = DEFAULT_ALL_DAY_REMINDER_TIME) {
  const offsets = normalizeReminders(task?.reminders, task?.dueDate, task?.dueTime);
  if (offsets.length === 0) return [];
  const timed = isTimeKey(task.dueTime);
  const time = isTimeKey(allDayTime) ? allDayTime : DEFAULT_ALL_DAY_REMINDER_TIME;
  return offsets.map((offset) => {
    if (timed) {
      // Count back on the wall clock (calendar days + minutes) so DST days do not shift reminders.
      const days = Math.floor(offset / DAY_MINUTES);
      const minutes = offset % DAY_MINUTES;
      const day = addDaysToKey(task.dueDate, -days);
      const base = localInstant(day, task.dueTime);
      return { offset, at: new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), base.getMinutes() - minutes) };
    }
    return { offset, at: localInstant(addDaysToKey(task.dueDate, -offset / DAY_MINUTES), time) };
  });
}
