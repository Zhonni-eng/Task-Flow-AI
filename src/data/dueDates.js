// Due-date state of a task, derived from its local "YYYY-MM-DD" due date and status.
// Nothing here is stored: overdue/today/upcoming always follow the current local date.
import { addDays, isValidDateKey, startOfToday, toDateKey } from '../utils/date.js';
import { deadlineInstant } from '../../electron/shared/schedule.mjs';

/**
 * 'none' (no due date), 'done' (completed: never overdue), 'overdue', 'today',
 * 'tomorrow' or 'upcoming' (later than tomorrow).
 * Date keys compare as strings; only a due time on the current day is compared with `now`
 * (a task due today at 16:30 is overdue from 16:30).
 */
export function dueState(task, today = startOfToday(), now = new Date()) {
  if (!isValidDateKey(task.dueDate)) return 'none';
  if (task.status === 'done') return 'done';
  const todayKey = toDateKey(today);
  if (task.dueDate < todayKey) return 'overdue';
  if (task.dueDate === todayKey && task.dueTime && toDateKey(now) === todayKey && now >= deadlineInstant(task)) return 'overdue';
  if (task.dueDate === todayKey) return 'today';
  if (task.dueDate === toDateKey(addDays(today, 1))) return 'tomorrow';
  return 'upcoming';
}

// Date-based filters, in the order they are offered.
export const DUE_FILTERS = ['overdue', 'today', 'upcoming'];

/**
 * - overdue:  due before today and not completed
 * - today:    due today (any status, so finished work for today stays visible)
 * - upcoming: due after today and not completed
 * Tasks without a due date never match.
 */
export function matchesDueFilter(task, filter, today = startOfToday()) {
  if (!isValidDateKey(task.dueDate)) return false;
  const todayKey = toDateKey(today);
  switch (filter) {
    case 'overdue':
      return task.status !== 'done' && task.dueDate < todayKey;
    case 'today':
      return task.dueDate === todayKey;
    case 'upcoming':
      return task.status !== 'done' && task.dueDate > todayKey;
    default:
      return false;
  }
}
