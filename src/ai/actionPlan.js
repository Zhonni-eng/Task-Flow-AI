// Validation of AI-proposed action plans. Everything a provider returns is untrusted input: this
// module only checks and normalizes it into entries a review UI can show. It never changes tasks -
// applying a validated plan is a separate step (applyPlan.js).
//
// Plan    = { actions: Action[], reply?: string, question?: string }
// Action  = { type: 'create', title, description?, dueDate?, dueTime?, priority?, status?,
//             categoryId?, newCategory?, subtasks?: string[], labels?: string[], reminders?, recurrence?, estimateMinutes? }
//         | { type: 'update', taskId, changes: { <same fields; null / [] / '' clears>, addLabels?, removeLabels? } }
//         | { type: 'delete', taskId }
//         | { type: 'addSubtask', taskId, title } | { type: 'updateSubtask', taskId, subtaskId, title?, done? }
//         | { type: 'deleteSubtask', taskId, subtaskId } | { type: 'moveSubtask', taskId, subtaskId, toTaskId }
//         | { type: 'bulk', operation: 'update' | 'delete', filter: {...}, changes?: {..., addLabels?, removeLabels?} }
//         | { type: 'renameLabel', label, newLabel } | { type: 'deleteLabel', label }   (every task with it)
//         (addLabels are added to the task's existing labels, removeLabels taken off only those tasks;
//          a label exists only on tasks, so deleting one globally takes it off every task - tasks stay)
//         | { type: 'schedule', date, items: [{ taskId, start }] }
//         | { type: 'none' }
//         (earlier versions' 'setStatus' / 'setDueDate' are accepted as updates)
//
// Rules reuse the task model (statuses, priorities, limits), the shared schedule rules (dates,
// times, reminders, recurrence) and the category matcher. Tasks may only be changed when the
// provider was actually shown them (`allowedTaskIds`); bulk filters are resolved here, against the
// real data, so the user sees exactly which tasks a bulk change touches.
import {
  isDateKey,
  isTimeKey,
  localDateKey,
  localTimeKey,
  normalizeEstimate,
  normalizeRecurrence,
  normalizeReminders,
  RECURRENCE_FREQUENCIES,
} from '../../electron/shared/schedule.mjs';
import { CATEGORY_NAME_LIMIT, normalizeCategoryName } from '../data/categoryModel.js';
import { findMatchingCategory } from '../data/categoryMatch.js';
import { SUBTASK_LIMIT, SUBTASK_TITLE_LIMIT, normalizeSubtaskTitle, validateSubtaskTitle } from '../data/subtasks.js';
import { DEFAULT_PRIORITY, DEFAULT_STATUS, LIMITS, PRIORITIES, TASK_STATUSES, normalizeLabels } from '../data/taskModel.js';
import { normalizeQuery } from '../state/taskView.js';

export const ACTION_TYPES = ['create', 'update', 'delete', 'addSubtask', 'updateSubtask', 'deleteSubtask', 'moveSubtask', 'bulk', 'schedule', 'renameLabel', 'deleteLabel', 'none'];
export const MAX_ACTIONS = 50;
export const MAX_BULK_TASKS = 500;
const MAX_TEXT = 2000;
const MAX_ID = 100;
const FIELD_NAMES = ['title', 'description', 'priority', 'status', 'dueDate', 'dueTime', 'categoryId', 'newCategory', 'subtasks', 'labels', 'reminders', 'recurrence', 'estimateMinutes', 'planned'];
const UPDATE_FIELDS = [...FIELD_NAMES.filter((field) => field !== 'subtasks' && field !== 'labels'), 'addLabels', 'removeLabels'];
const BULK_FIELDS = ['status', 'priority', 'categoryId', 'newCategory', 'dueDate', 'dueTime', 'addLabels', 'removeLabels'];
const LABEL_EDITS = ['addLabels', 'removeLabels'];
const FILTER_FIELDS = ['status', 'categoryId', 'priority', 'due', 'completedOlderThanDays', 'titleContains', 'scope'];
const DUE_FILTERS = ['overdue', 'today', 'upcoming', 'noDate'];
const ACTION_FIELDS = {
  create: ['type', ...FIELD_NAMES],
  update: ['type', 'taskId', 'changes'],
  delete: ['type', 'taskId'],
  addSubtask: ['type', 'taskId', 'title'],
  updateSubtask: ['type', 'taskId', 'subtaskId', 'title', 'done'],
  deleteSubtask: ['type', 'taskId', 'subtaskId'],
  moveSubtask: ['type', 'taskId', 'subtaskId', 'toTaskId'],
  bulk: ['type', 'operation', 'filter', 'changes'],
  schedule: ['type', 'date', 'items'],
  renameLabel: ['type', 'label', 'newLabel'],
  deleteLabel: ['type', 'label'],
  none: ['type'],
};
const PLAN_FIELDS = ['actions', 'reply', 'question'];
// Fields whose change is compared to tell "no change".
const COMPARED = ['title', 'description', 'priority', 'status', 'dueDate', 'dueTime', 'categoryId', 'reminders', 'recurrence', 'estimateMinutes', 'planned'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const titleKey = (title) => normalizeQuery(title);
/** Labels a task has after adding `added` (the model's rules: trimmed, no case duplicates, limits). */
const withLabels = (labels, added) => normalizeLabels([...(labels ?? []), ...added]);
const labelKeys = (labels) => (labels ?? []).map((label) => label.toLocaleLowerCase());
const labelKey = (label) => label.toLocaleLowerCase();
const hasLabel = (task, label) => labelKeys(task.labels).includes(labelKey(label));
/** Labels after taking `removed` off and adding `added` (case-insensitive, existing ones kept). */
const editLabels = (labels, added = [], removed = []) => {
  const gone = new Set(removed.map(labelKey));
  return withLabels((labels ?? []).filter((label) => !gone.has(labelKey(label))), added);
};
/** Labels with `from` renamed to `to` (merged when the task already has `to`). */
const renameLabelIn = (labels, from, to) => normalizeLabels((labels ?? []).map((label) => (labelKey(label) === labelKey(from) ? to : label)));
const changesLabels = (task, values) => !same(editLabels(task.labels, values.addLabels, values.removeLabels), task.labels ?? []);
/** One label given by the provider, normalized, or null. */
const checkLabel = (value) => (typeof value === 'string' && value.trim() && value.trim().length <= LIMITS.label ? normalizeLabels([value])[0] : null);
const exceedsLabels = (task, added) => (task.labels?.length ?? 0) + added.filter((label) => !labelKeys(task.labels).includes(label.toLocaleLowerCase())).length > LIMITS.labels;

/** Earlier action types, accepted as updates. */
function upgradeLegacy(raw) {
  if (!isPlainObject(raw)) return raw;
  if (raw.type === 'setStatus') return { type: 'update', taskId: raw.taskId, changes: { status: raw.status } };
  if (raw.type === 'setDueDate') return { type: 'update', taskId: raw.taskId, changes: { dueDate: raw.dueDate } };
  return raw;
}

/** The date/time for "overdue" and "completed older than": local, from `now`. */
function clock(now) {
  return { todayKey: localDateKey(now), time: localTimeKey(now) };
}

/**
 * Checks task fields given by the provider. `base` is the task they apply to (null for a new task).
 * Returns { values, errors, newCategory, category } - `values` holds only given fields, normalized.
 */
function checkFields(raw, base, context, errors) {
  const values = {};
  let newCategory = null;
  let category = null;
  const given = (field) => Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined;

  if (given('title')) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) errors.push('titleRequired');
    else if (raw.title.trim().length > LIMITS.title) errors.push('titleTooLong');
    else values.title = raw.title.trim();
  }
  if (given('description')) {
    if (raw.description !== null && (typeof raw.description !== 'string' || raw.description.length > LIMITS.description)) errors.push('invalidDescription');
    else values.description = (raw.description ?? '').trim();
  }
  if (given('priority')) {
    if (PRIORITIES.includes(raw.priority)) values.priority = raw.priority;
    else errors.push('invalidPriority');
  }
  if (given('status')) {
    if (TASK_STATUSES.includes(raw.status)) values.status = raw.status;
    else errors.push('invalidStatus');
  }
  if (given('dueDate')) {
    const key = typeof raw.dueDate === 'string' ? raw.dueDate.trim() : raw.dueDate;
    if (key === null) values.dueDate = null;
    else if (isDateKey(key)) values.dueDate = key;
    else errors.push('invalidDate');
  }
  // Time, reminders and repeat depend on the due date the task will have.
  const dueDate = 'dueDate' in values ? values.dueDate : base?.dueDate ?? null;
  if (given('dueTime')) {
    const time = typeof raw.dueTime === 'string' ? raw.dueTime.trim() : raw.dueTime;
    if (time === null) values.dueTime = null;
    else if (!isTimeKey(time)) errors.push('invalidTime');
    else if (!dueDate) errors.push('timeWithoutDate');
    else values.dueTime = time;
  }
  const dueTime = 'dueTime' in values ? values.dueTime : 'dueDate' in values && values.dueDate === null ? null : base?.dueTime ?? null;
  if (given('reminders')) {
    if (!Array.isArray(raw.reminders)) errors.push('invalidReminders');
    else if (raw.reminders.length === 0) values.reminders = [];
    else if (!dueDate) errors.push('remindersWithoutDate');
    else {
      const normalized = normalizeReminders(raw.reminders, dueDate, dueTime);
      if (normalized.length !== new Set(raw.reminders).size) errors.push('invalidReminders');
      else values.reminders = normalized;
    }
  }
  if (given('recurrence')) {
    if (raw.recurrence === null) values.recurrence = null;
    else if (!isPlainObject(raw.recurrence) || !RECURRENCE_FREQUENCIES.includes(raw.recurrence.freq)) errors.push('invalidRecurrence');
    else if (!dueDate) errors.push('recurrenceWithoutDate');
    else values.recurrence = normalizeRecurrence(raw.recurrence, dueDate);
  }
  if (given('estimateMinutes')) {
    if (raw.estimateMinutes === null) values.estimateMinutes = null;
    else {
      const estimate = normalizeEstimate(raw.estimateMinutes);
      if (estimate === null) errors.push('invalidEstimate');
      else values.estimateMinutes = estimate;
    }
  }
  for (const field of ['labels', 'addLabels', 'removeLabels']) {
    if (!given(field)) continue;
    const list = raw[field];
    if (!Array.isArray(list) || list.some((label) => typeof label !== 'string' || !label.trim() || label.trim().length > LIMITS.label)) errors.push('invalidLabels');
    else if (normalizeLabels(list).length < new Set(list.map((label) => label.trim().toLocaleLowerCase())).size) errors.push('invalidLabels');
    else values[field] = normalizeLabels(list);
  }
  if (values.addLabels && values.removeLabels?.some((label) => values.addLabels.map(labelKey).includes(labelKey(label)))) errors.push('labelConflict');
  if (given('planned')) {
    if (raw.planned === null) values.planned = null;
    else errors.push('unknownField');
  }
  if (given('categoryId') && raw.categoryId !== null && raw.categoryId !== '') {
    if (!checkId(raw.categoryId)) errors.push('invalidCategory');
    else if (!context.categories) errors.push('notVerified');
    else {
      category = context.categories.find((item) => item.id === raw.categoryId) ?? null;
      if (!category) errors.push('unknownCategory');
      else values.categoryId = category.id;
    }
  } else if (given('categoryId')) {
    values.categoryId = null;
  }
  if (given('newCategory') && raw.newCategory !== '' && raw.newCategory !== null && !('categoryId' in values && values.categoryId)) {
    const name = typeof raw.newCategory === 'string' ? normalizeCategoryName(raw.newCategory) : '';
    if (!name || raw.newCategory.trim().length > CATEGORY_NAME_LIMIT) errors.push('invalidCategory');
    else {
      // Reuse an existing category (other case, word form, synonym) before proposing a new one.
      category = findMatchingCategory(name, context.categories ?? []);
      if (category) values.categoryId = category.id;
      else newCategory = name;
    }
  }
  return { values, newCategory, category };
}

/** Tasks matching a bulk filter (the app decides, not the provider). */
export { withLabels, editLabels, renameLabelIn };

export function resolveBulkFilter(filter, tasks, now = new Date()) {
  const { todayKey, time } = clock(now);
  const titlePart = filter.titleContains ? titleKey(filter.titleContains) : null;
  const cutoff = filter.completedOlderThanDays ? new Date(now.getTime() - filter.completedOlderThanDays * 86_400_000) : null;
  return tasks.filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.priority && task.priority !== filter.priority) return false;
    if (filter.categoryId !== undefined && (task.categoryId ?? null) !== filter.categoryId) return false;
    if (titlePart && !titleKey(task.title).includes(titlePart)) return false;
    if (filter.due === 'noDate' && task.dueDate) return false;
    if (filter.due === 'overdue') {
      const overdue = task.status !== 'done' && task.dueDate && (task.dueDate < todayKey || (task.dueDate === todayKey && task.dueTime && task.dueTime <= time));
      if (!overdue) return false;
    }
    if (filter.due === 'today' && task.dueDate !== todayKey) return false;
    if (filter.due === 'upcoming' && !(task.status !== 'done' && task.dueDate && task.dueDate > todayKey)) return false;
    if (cutoff) {
      // "Completed more than N days ago": done tasks with a known completion time only.
      if (task.status !== 'done' || !task.completedAt || !(new Date(task.completedAt) < cutoff)) return false;
    }
    return true;
  });
}

/**
 * Validates a plan against the current data.
 * `context`: { tasks?, categories?, allowedTaskIds?, availability?, now? } - without `tasks` /
 * `categories`, references to them cannot be checked and are errors ('notVerified').
 *
 * Result: { ok, errors: string[], reply, question, actions: Entry[] } with
 * Entry = { index, type, valid, errors, warnings, normalized, target?, category?, newCategory?, matches? }
 */
export function validateActionPlan(plan, context = {}) {
  const result = { ok: false, errors: [], reply: null, question: null, actions: [] };
  if (!isPlainObject(plan)) {
    result.errors.push('invalidPlan');
    return result;
  }
  if (Object.keys(plan).some((key) => !PLAN_FIELDS.includes(key))) result.errors.push('unknownField');
  for (const field of ['reply', 'question']) {
    if (plan[field] === undefined || plan[field] === null) continue;
    if (typeof plan[field] !== 'string' || plan[field].length > MAX_TEXT) result.errors.push(`invalid_${field}`);
    else result[field] = plan[field].trim() || null;
  }
  if (!Array.isArray(plan.actions)) {
    result.errors.push('invalidActions');
    return result;
  }
  if (plan.actions.length > MAX_ACTIONS) {
    result.errors.push('tooManyActions');
    return result;
  }

  const now = context.now ?? new Date();
  const tasks = Array.isArray(context.tasks) ? context.tasks : null;
  const categories = Array.isArray(context.categories) ? context.categories : null;
  const ctx = { ...context, categories };
  const taskById = tasks ? new Map(tasks.map((task) => [task.id, task])) : null;
  const allowed = context.allowedTaskIds ? new Set(context.allowedTaskIds) : null;
  const existingTitles = new Map();
  for (const task of tasks ?? []) {
    const key = titleKey(task.title);
    if (!existingTitles.has(key)) existingTitles.set(key, []);
    existingTitles.get(key).push(task.id);
  }
  const plannedTitles = new Map();
  const touched = new Map(); // task id -> index of the first action touching it

  plan.actions.forEach((original, index) => {
    const raw = upgradeLegacy(original);
    const entry = { index, type: null, valid: false, errors: [], warnings: [], normalized: null };
    result.actions.push(entry);
    if (!isPlainObject(raw)) {
      entry.errors.push('invalidAction');
      return;
    }
    if (!ACTION_TYPES.includes(raw.type)) {
      entry.errors.push('unknownType');
      return;
    }
    entry.type = raw.type;
    if (Object.keys(raw).some((key) => !ACTION_FIELDS[raw.type].includes(key))) entry.errors.push('unknownField');

    const checkTask = (taskId, field = 'target') => {
      if (!checkId(taskId)) {
        entry.errors.push('invalidTaskId');
        return null;
      }
      if (!taskById) {
        entry.errors.push('notVerified');
        return null;
      }
      if (allowed && !allowed.has(taskId)) {
        entry.errors.push('notOffered');
        return null;
      }
      const task = taskById.get(taskId);
      if (!task) {
        entry.errors.push('unknownTask');
        return null;
      }
      entry[field] = task;
      return task;
    };
    const touch = (taskId) => {
      if (touched.has(taskId)) entry.warnings.push('conflictsWithEarlier');
      else touched.set(taskId, index);
    };
    const checkSubtask = (task, subtaskId) => {
      if (!checkId(subtaskId)) {
        entry.errors.push('invalidSubtask');
        return null;
      }
      const subtask = task?.subtasks?.find((item) => item.id === subtaskId) ?? null;
      if (task && !subtask) entry.errors.push('unknownSubtask');
      return subtask;
    };

    switch (raw.type) {
      case 'create': {
        if (typeof raw.title !== 'string' || !raw.title.trim()) entry.errors.push('titleRequired');
        const { values, newCategory, category } = checkFields(raw, null, ctx, entry.errors);
        const subtasks = [];
        if (raw.subtasks !== undefined) {
          if (!Array.isArray(raw.subtasks) || raw.subtasks.length > SUBTASK_LIMIT) entry.errors.push('invalidSubtasks');
          else {
            for (const item of raw.subtasks) {
              if (typeof item !== 'string' || validateSubtaskTitle(item) || item.trim().length > SUBTASK_TITLE_LIMIT) {
                entry.errors.push('invalidSubtasks');
                break;
              }
              subtasks.push(normalizeSubtaskTitle(item));
            }
          }
        }
        entry.normalized = {
          fields: {
            title: values.title ?? '',
            description: values.description ?? '',
            priority: values.priority ?? DEFAULT_PRIORITY,
            status: values.status ?? DEFAULT_STATUS,
            dueDate: values.dueDate ?? null,
            dueTime: values.dueTime ?? null,
            reminders: values.reminders ?? [],
            recurrence: values.recurrence ?? null,
            estimateMinutes: values.estimateMinutes ?? null,
            categoryId: values.categoryId ?? null,
            labels: values.labels ?? [],
            subtasks,
          },
          newCategory,
        };
        entry.category = category;
        entry.newCategory = newCategory;
        if (values.title) {
          const key = titleKey(values.title);
          if (existingTitles.has(key)) {
            entry.warnings.push('possibleDuplicate');
            entry.duplicateOf = [...existingTitles.get(key)];
          }
          if (plannedTitles.has(key)) {
            entry.warnings.push('duplicateInPlan');
            entry.duplicateOfAction = plannedTitles.get(key);
          } else plannedTitles.set(key, index);
        }
        break;
      }
      case 'update': {
        const task = checkTask(raw.taskId);
        if (!isPlainObject(raw.changes) || Object.keys(raw.changes).length === 0) {
          entry.errors.push('invalidChanges');
          break;
        }
        if (Object.keys(raw.changes).some((key) => !UPDATE_FIELDS.includes(key))) entry.errors.push('unknownField');
        const { values, newCategory, category } = checkFields(raw.changes, task, ctx, entry.errors);
        // Clearing the due date clears what depends on it.
        if (values.dueDate === null && task?.dueDate) Object.assign(values, { dueTime: null, reminders: [], recurrence: null });
        if (values.dueTime === null && task?.reminders?.length) values.reminders = normalizeReminders(task.reminders, values.dueDate ?? task.dueDate, null);
        entry.normalized = { taskId: raw.taskId, changes: values, newCategory };
        entry.category = category;
        entry.newCategory = newCategory;
        if (task) {
          const labelsChange = LABEL_EDITS.some((field) => field in values) && changesLabels(task, values);
          if (!newCategory && !labelsChange && COMPARED.every((field) => !(field in values) || same(values[field], task[field]))) entry.warnings.push('noChange');
          if (values.addLabels && exceedsLabels(task, values.addLabels)) entry.warnings.push('labelLimit');
          if (values.status === 'done' && task.recurrence && task.status !== 'done') entry.warnings.push('advancesRecurrence');
          touch(task.id);
        }
        break;
      }
      case 'delete': {
        const task = checkTask(raw.taskId);
        entry.normalized = { taskId: raw.taskId };
        if (task) {
          if (task.subtasks?.length) entry.warnings.push('deletesSubtasks');
          if (task.recurrence) entry.warnings.push('deletesSeries');
          touch(task.id);
        }
        break;
      }
      case 'addSubtask': {
        const task = checkTask(raw.taskId);
        if (typeof raw.title !== 'string' || validateSubtaskTitle(raw.title) || raw.title.trim().length > SUBTASK_TITLE_LIMIT) entry.errors.push('invalidSubtasks');
        else if (task && task.subtasks.length >= SUBTASK_LIMIT) entry.errors.push('tooManySubtasks');
        entry.normalized = { taskId: raw.taskId, title: typeof raw.title === 'string' ? normalizeSubtaskTitle(raw.title) : '' };
        if (task && task.subtasks.some((subtask) => titleKey(subtask.title) === titleKey(entry.normalized.title))) entry.warnings.push('possibleDuplicate');
        if (task) touch(task.id);
        break;
      }
      case 'updateSubtask': {
        const task = checkTask(raw.taskId);
        const subtask = checkSubtask(task, raw.subtaskId);
        const changes = {};
        if (raw.title !== undefined) {
          if (typeof raw.title !== 'string' || validateSubtaskTitle(raw.title) || raw.title.trim().length > SUBTASK_TITLE_LIMIT) entry.errors.push('invalidSubtasks');
          else changes.title = normalizeSubtaskTitle(raw.title);
        }
        if (raw.done !== undefined) {
          if (typeof raw.done !== 'boolean') entry.errors.push('invalidSubtasks');
          else changes.done = raw.done;
        }
        if (Object.keys(changes).length === 0 && !entry.errors.includes('invalidSubtasks')) entry.errors.push('invalidChanges');
        entry.normalized = { taskId: raw.taskId, subtaskId: raw.subtaskId, changes };
        entry.subtask = subtask;
        if (subtask && Object.entries(changes).every(([key, value]) => subtask[key] === value)) entry.warnings.push('noChange');
        if (task) touch(task.id);
        break;
      }
      case 'deleteSubtask': {
        const task = checkTask(raw.taskId);
        entry.subtask = checkSubtask(task, raw.subtaskId);
        entry.normalized = { taskId: raw.taskId, subtaskId: raw.subtaskId };
        if (task) touch(task.id);
        break;
      }
      case 'moveSubtask': {
        const task = checkTask(raw.taskId);
        entry.subtask = checkSubtask(task, raw.subtaskId);
        const destination = checkTask(raw.toTaskId, 'destination');
        // One level only: a subtask moves between two different existing tasks, never into itself.
        if (raw.toTaskId === raw.taskId) entry.errors.push('sameTask');
        else if (destination && destination.subtasks.length >= SUBTASK_LIMIT) entry.errors.push('tooManySubtasks');
        entry.normalized = { taskId: raw.taskId, subtaskId: raw.subtaskId, toTaskId: raw.toTaskId };
        if (task) touch(task.id);
        if (destination) touch(destination.id);
        break;
      }
      case 'bulk': {
        if (!['update', 'delete'].includes(raw.operation)) entry.errors.push('invalidOperation');
        const filter = {};
        if (!isPlainObject(raw.filter)) entry.errors.push('invalidFilter');
        else {
          if (Object.keys(raw.filter).some((key) => !FILTER_FIELDS.includes(key))) entry.errors.push('unknownField');
          const f = raw.filter;
          if (f.status !== undefined) (TASK_STATUSES.includes(f.status) ? (filter.status = f.status) : entry.errors.push('invalidFilter'));
          if (f.priority !== undefined) (PRIORITIES.includes(f.priority) ? (filter.priority = f.priority) : entry.errors.push('invalidFilter'));
          if (f.due !== undefined) (DUE_FILTERS.includes(f.due) ? (filter.due = f.due) : entry.errors.push('invalidFilter'));
          if (f.completedOlderThanDays !== undefined) {
            if (Number.isInteger(f.completedOlderThanDays) && f.completedOlderThanDays > 0 && f.completedOlderThanDays <= 3650) filter.completedOlderThanDays = f.completedOlderThanDays;
            else entry.errors.push('invalidFilter');
          }
          if (f.titleContains !== undefined) (typeof f.titleContains === 'string' && f.titleContains.trim() && f.titleContains.length <= LIMITS.title ? (filter.titleContains = f.titleContains.trim()) : entry.errors.push('invalidFilter'));
          // "All tasks" must be said explicitly (scope 'all'); it matches every task, done ones included.
          if (f.scope !== undefined) (f.scope === 'all' ? (filter.scope = 'all') : entry.errors.push('invalidFilter'));
          if (f.categoryId !== undefined) {
            if (!categories) entry.errors.push('notVerified');
            else if (categories.some((category) => category.id === f.categoryId)) filter.categoryId = f.categoryId;
            else entry.errors.push('unknownCategory');
          }
        }
        // Never "all tasks" by omission: a bulk change needs a criterion or the explicit scope 'all'.
        if (Object.keys(filter).length === 0 && !entry.errors.includes('invalidFilter')) entry.errors.push('emptyFilter');
        let values = {};
        let newCategory = null;
        if (raw.operation === 'update') {
          const changes = isPlainObject(raw.changes) ? raw.changes : {};
          if (Object.keys(changes).length === 0) entry.errors.push('invalidChanges');
          if (Object.keys(changes).some((key) => !BULK_FIELDS.includes(key))) entry.errors.push('unknownField');
          ({ values, newCategory } = checkFields(changes, null, ctx, entry.errors));
          if ('dueTime' in values && values.dueTime && !('dueDate' in values)) {
            // A time for many tasks needs a date: only tasks that have one keep it valid.
            entry.warnings.push('timeKeepsDates');
          }
        } else if (raw.changes !== undefined && isPlainObject(raw.changes) && Object.keys(raw.changes).length > 0) entry.errors.push('unknownField');
        if (!tasks) entry.errors.push('notVerified');
        let matches = tasks && entry.errors.length === 0 ? resolveBulkFilter(filter, tasks, now) : [];
        if (values.addLabels && matches.some((task) => exceedsLabels(task, values.addLabels))) entry.warnings.push('labelLimit');
        // A change of tags only affects the tasks whose tags actually change (shown as such).
        if (raw.operation === 'update' && !newCategory && Object.keys(values).length > 0 && Object.keys(values).every((key) => LABEL_EDITS.includes(key))) {
          matches = matches.filter((task) => changesLabels(task, values));
        }
        if (matches.length > MAX_BULK_TASKS) entry.errors.push('tooManyTasks');
        entry.matches = matches.map((task) => task.id);
        entry.matchedTasks = matches;
        entry.newCategory = newCategory;
        entry.normalized = { operation: raw.operation, filter, changes: values, newCategory, matches: entry.matches };
        if (entry.errors.length === 0 && matches.length === 0) entry.warnings.push('noMatches');
        for (const task of matches) if (touched.has(task.id)) entry.warnings.push('conflictsWithEarlier');
        for (const task of matches) if (!touched.has(task.id)) touched.set(task.id, index);
        break;
      }
      case 'schedule': {
        if (!isDateKey(raw.date)) entry.errors.push('invalidDate');
        else if (raw.date < clock(now).todayKey) entry.errors.push('dateInPast');
        if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_ACTIONS) {
          entry.errors.push('invalidSchedule');
          break;
        }
        const availability = context.availability ?? null;
        if (!availability) entry.errors.push('noAvailability');
        const items = [];
        for (const item of raw.items) {
          if (!isPlainObject(item) || !isTimeKey(item.start)) {
            entry.errors.push('invalidSchedule');
            break;
          }
          const task = checkTask(item.taskId, 'lastTarget');
          if (!task) continue;
          if (task.status === 'done') entry.errors.push('taskDone');
          const [hours, minutes] = item.start.split(':').map(Number);
          const startMin = hours * 60 + minutes;
          const endMin = task.estimateMinutes ? startMin + task.estimateMinutes : null;
          if (!task.estimateMinutes) entry.warnings.push('noEstimate');
          if (availability) {
            const [ah, am] = availability.start.split(':').map(Number);
            const [bh, bm] = availability.end.split(':').map(Number);
            if (startMin < ah * 60 + am || (endMin ?? startMin) > bh * 60 + bm) entry.errors.push('outsideAvailability');
          }
          if (task.dueDate && raw.date > task.dueDate) entry.warnings.push('afterDeadline');
          items.push({ taskId: task.id, title: task.title, start: item.start, startMin, endMin });
          touch(task.id);
        }
        delete entry.lastTarget;
        const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i - 1].endMin !== null && sorted[i].startMin < sorted[i - 1].endMin) entry.errors.push('overlap');
        }
        entry.normalized = { date: raw.date, items };
        break;
      }
      case 'renameLabel':
      case 'deleteLabel': {
        // Global: every task that has the label (any case), resolved by the app like a bulk change.
        const rename = raw.type === 'renameLabel';
        const label = checkLabel(raw.label);
        const newLabel = rename ? checkLabel(raw.newLabel) : null;
        if (!label || (rename && !newLabel)) entry.errors.push('invalidLabels');
        if (!tasks) entry.errors.push('notVerified');
        const matches = label && tasks ? tasks.filter((task) => hasLabel(task, label)) : [];
        if (label && tasks && matches.length === 0) entry.errors.push('unknownLabel');
        if (matches.length > MAX_BULK_TASKS) entry.errors.push('tooManyTasks');
        if (rename && label && newLabel === label) entry.warnings.push('noChange');
        entry.matches = matches.map((task) => task.id);
        entry.matchedTasks = matches;
        entry.normalized = rename ? { label, newLabel, matches: entry.matches } : { label, matches: entry.matches };
        for (const task of matches) if (touched.has(task.id)) entry.warnings.push('conflictsWithEarlier');
        for (const task of matches) if (!touched.has(task.id)) touched.set(task.id, index);
        break;
      }
      case 'none':
        entry.normalized = {};
        break;
      default:
        break;
    }
    entry.errors = [...new Set(entry.errors)];
    entry.warnings = [...new Set(entry.warnings)];
    entry.valid = entry.errors.length === 0;
    if (!entry.valid) entry.normalized = null;
  });

  result.ok = result.errors.length === 0 && result.actions.every((entry) => entry.valid);
  return result;
}
