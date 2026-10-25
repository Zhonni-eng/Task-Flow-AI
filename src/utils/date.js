// Date-only helpers. Due dates are stored as local "YYYY-MM-DD" keys so they
// serialize cleanly and are not shifted by time zones.

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDateKey(key) {
  const match = DATE_KEY.exec(key ?? '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === key ? date : null;
}

export function isValidDateKey(key) {
  return parseDateKey(key) !== null;
}

export function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function isSameDay(a, b) {
  return (
    a != null &&
    b != null &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days from today to `date` (negative = past). */
export function daysFromToday(date) {
  return Math.round((date - startOfToday()) / (24 * 60 * 60 * 1000));
}

/** Start of the calendar week that follows `date` (`weekStart`: 0 = Sunday, 1 = Monday). */
export function startOfNextWeek(date, weekStart) {
  const offset = (date.getDay() - weekStart + 7) % 7;
  return addDays(date, 7 - offset);
}

// Quick due-date choices shared by every date picker (task editor and bulk actions).
export const QUICK_DATES = ['today', 'tomorrow', 'in7Days', 'nextWeek'];

/** Local date for a quick choice; "next week" is the first day of the next calendar week. */
export function quickDate(kind, today, weekStart) {
  switch (kind) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'in7Days':
      return addDays(today, 7);
    case 'nextWeek':
      return startOfNextWeek(today, weekStart);
    default:
      return null;
  }
}
