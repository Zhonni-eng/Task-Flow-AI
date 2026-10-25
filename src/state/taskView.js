// Read-only view of the task collection: search, filters, sorting and statistics.
// Nothing here modifies tasks or their saved manual order; the view state is temporary.
import { dueState, matchesDueFilter } from '../data/dueDates.js';
import { TASK_STATUSES } from '../data/taskModel.js';
import { startOfToday } from '../utils/date.js';
import { compareTasks } from './tasksReducer.js';

export const SORT_MODES = ['manual', 'dueDate', 'priority', 'title'];

export const EMPTY_VIEW = Object.freeze({
  query: '',
  statuses: [],
  priorities: [],
  labels: [],
  due: [],
  sort: 'manual',
});

/** Case-insensitive, whitespace-tolerant text form; treats Russian "ё" as "е". */
function fold(text) {
  return String(text ?? '').toLocaleLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

export function normalizeQuery(query) {
  return fold(String(query ?? '').trim());
}

const labelKey = (label) => label.toLocaleLowerCase();

/** True when search or any filter hides part of the collection. */
export function isFiltering(view) {
  return (
    normalizeQuery(view.query) !== '' ||
    view.statuses.length > 0 ||
    view.priorities.length > 0 ||
    view.labels.length > 0 ||
    (view.due?.length ?? 0) > 0
  );
}

/** Drag-and-drop is only safe on the complete board in manual order. */
export function isDragAllowed(view) {
  return !isFiltering(view) && view.sort === 'manual';
}

/** `today` is the start of the current local day (date filters compare calendar dates). */
export function matchesView(task, view, today = startOfToday()) {
  const query = normalizeQuery(view.query);
  if (query && !fold(task.title).includes(query) && !fold(task.description).includes(query)) return false;
  if (view.statuses.length > 0 && !view.statuses.includes(task.status)) return false;
  if (view.priorities.length > 0 && !view.priorities.includes(task.priority)) return false;
  if (view.labels.length > 0) {
    const taskLabels = new Set(task.labels.map(labelKey));
    if (!view.labels.some((label) => taskLabels.has(labelKey(label)))) return false;
  }
  if (view.due?.length > 0 && !view.due.some((filter) => matchesDueFilter(task, filter, today))) return false;
  return true;
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/** Compares only the sort key of a mode (0 on ties; always 0 for manual). */
function primaryComparator(sort, locale) {
  switch (sort) {
    case 'dueDate':
      // Earliest first; tasks without a due date go last.
      return (a, b) => {
        if (a.dueDate === b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      };
    case 'priority':
      return (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'title': {
      const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
      return (a, b) => collator.compare(a.title, b.title);
    }
    default:
      return () => 0;
  }
}

/** Comparator for a sort mode. Ties always fall back to the manual order. */
export function createComparator(sort, locale) {
  const primary = primaryComparator(sort, locale);
  return (a, b) => primary(a, b) || compareTasks(a, b);
}

/**
 * Visible tasks per column plus totals.
 * Returns { columns: { status: Task[] }, totals: { status: number }, shown, total }.
 */
export function buildBoardView(tasks, view, locale, today = startOfToday()) {
  const compare = createComparator(view.sort, locale);
  const columns = {};
  const totals = {};
  let shown = 0;
  for (const status of TASK_STATUSES) {
    const inColumn = tasks.filter((task) => task.status === status);
    totals[status] = inColumn.length;
    columns[status] = inColumn.filter((task) => matchesView(task, view, today)).sort(compare);
    shown += columns[status].length;
  }
  return { columns, totals, shown, total: tasks.length };
}

/**
 * Flat list for the List View: manual order groups by status (To Do, In Progress,
 * Done) then manual position; other sorts apply across all statuses.
 */
export function buildListView(tasks, view, locale, today = startOfToday()) {
  const statusRank = (task) => TASK_STATUSES.indexOf(task.status);
  const primary = primaryComparator(view.sort, locale);
  return tasks
    .filter((task) => matchesView(task, view, today))
    .sort((a, b) => primary(a, b) || statusRank(a) - statusRank(b) || compareTasks(a, b));
}

// ---------- Category scope ----------
export const ALL_TASKS = '__all__';
export const UNCATEGORIZED = '__uncategorized__';

/** Tasks belonging to a sidebar destination (all tasks, uncategorized, or one category). */
export function scopeTasks(tasks, destination) {
  if (destination === ALL_TASKS) return tasks;
  if (destination === UNCATEGORIZED) return tasks.filter((task) => task.categoryId === null);
  return tasks.filter((task) => task.categoryId === destination);
}

/** Task counts per destination for the sidebar. */
export function countByCategory(tasks) {
  const counts = { [ALL_TASKS]: tasks.length, [UNCATEGORIZED]: 0 };
  for (const task of tasks) {
    const key = task.categoryId ?? UNCATEGORIZED;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Converts a drop position within a scoped (category) column into the index within
 * the full column, so tasks hidden by the scope keep their relative order.
 * `visibleIds` is the visible column before the move.
 */
export function toFullColumnIndex(fullIds, visibleIds, taskId, visibleIndex) {
  const visible = visibleIds.filter((id) => id !== taskId);
  const full = fullIds.filter((id) => id !== taskId);
  visible.splice(visibleIndex, 0, taskId);
  const next = visible[visibleIndex + 1];
  const previous = visible[visibleIndex - 1];
  if (next !== undefined && full.includes(next)) return full.indexOf(next);
  if (previous !== undefined && full.includes(previous)) return full.indexOf(previous) + 1;
  return full.length;
}

/** Statistics over the whole collection (each task id counted once). */
export function computeStats(tasks, today = startOfToday()) {
  const seen = new Set();
  let done = 0;
  let overdue = 0;
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (task.status === 'done') {
      done += 1;
    } else if (dueState(task, today) === 'overdue') {
      overdue += 1;
    }
  }
  const total = seen.size;
  return { total, done, overdue, percent: total > 0 ? Math.round((done / total) * 100) : null };
}
