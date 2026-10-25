// Task data model: shape, defaults, normalization and validation.
//
// Task = {
//   id: string, title: string, description: string,
//   priority: 'low' | 'medium' | 'high',
//   dueDate: 'YYYY-MM-DD' | null,
//   dueTime: 'HH:MM' | null,   // local wall-clock deadline time; only with a due date
//   reminders: number[],       // minutes before the deadline (see electron/shared/schedule.mjs)
//   recurrence: { freq, interval, weekdays?, monthDay? } | null, // dueDate = next occurrence
//   estimateMinutes: number | null,
//   planned: { date: 'YYYY-MM-DD', time: 'HH:MM' } | null, // accepted day-plan slot (not a deadline)
//   completedAt: ISO string | null, // last time it (or an occurrence of it) was completed
//   labels: string[],
//   status: 'todo' | 'inProgress' | 'done',
//   order: number,            // position within its column (0 = top)
//   categoryId: string | null, // owning category; null = uncategorized
//   subtasks: { id, title, done }[], // optional one-level checklist (see subtasks.js)
//   createdAt: ISO string, updatedAt: ISO string,
// }
import { isValidDateKey } from '../utils/date.js';
import { isDateKey, isTimeKey, normalizeDueTime, normalizeEstimate, normalizeRecurrence, normalizeReminders } from '../../electron/shared/schedule.mjs';
import { normalizeSubtasks } from './subtasks.js';

export const TASK_STATUSES = ['todo', 'inProgress', 'done'];
export const PRIORITIES = ['low', 'medium', 'high'];

export const DEFAULT_STATUS = 'todo';
export const DEFAULT_PRIORITY = 'medium';

export const LIMITS = {
  title: 120,
  description: 2000,
  label: 30,
  labels: 10,
};

/** Fields the user can edit through the task form. */
export const EDITABLE_FIELDS = [
  'title', 'description', 'priority', 'dueDate', 'dueTime', 'reminders', 'recurrence', 'estimateMinutes', 'planned',
  'labels', 'status', 'categoryId', 'subtasks',
];

/** A day-plan slot { date, time } or null. */
export function normalizePlanned(value) {
  return value && typeof value === 'object' && isDateKey(value.date) && isTimeKey(value.time) ? { date: value.date, time: value.time } : null;
}

function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Splits free text ("design, ui") into label candidates. */
export function splitLabels(text) {
  return String(text ?? '').split(',');
}

/** Trims, collapses whitespace, drops empties and case-insensitive duplicates, applies limits. */
export function normalizeLabels(labels) {
  const seen = new Set();
  const result = [];
  for (const raw of labels ?? []) {
    const label = String(raw).replace(/\s+/g, ' ').trim().slice(0, LIMITS.label).trimEnd();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
    if (result.length === LIMITS.labels) break;
  }
  return result;
}

function normalizeFields(fields) {
  const dueDate = isValidDateKey(fields.dueDate) ? fields.dueDate : null;
  const dueTime = normalizeDueTime(fields.dueTime, dueDate);
  return {
    title: String(fields.title ?? '').trim().slice(0, LIMITS.title).trimEnd(),
    description: String(fields.description ?? '').trim().slice(0, LIMITS.description).trimEnd(),
    priority: PRIORITIES.includes(fields.priority) ? fields.priority : DEFAULT_PRIORITY,
    dueDate,
    dueTime,
    reminders: normalizeReminders(fields.reminders, dueDate, dueTime),
    recurrence: normalizeRecurrence(fields.recurrence, dueDate),
    estimateMinutes: normalizeEstimate(fields.estimateMinutes),
    planned: normalizePlanned(fields.planned),
    labels: normalizeLabels(fields.labels),
    status: TASK_STATUSES.includes(fields.status) ? fields.status : DEFAULT_STATUS,
    categoryId: typeof fields.categoryId === 'string' && fields.categoryId ? fields.categoryId : null,
    subtasks: normalizeSubtasks(fields.subtasks),
  };
}

/** Returns a map of field -> error code. Empty object means valid. */
export function validateTaskFields(fields) {
  const errors = {};
  if (!String(fields.title ?? '').trim()) errors.title = 'titleRequired';
  return errors;
}

export function createTask(fields = {}) {
  const now = new Date().toISOString();
  return {
    id: fields.id ?? generateId(),
    ...normalizeFields(fields),
    order: Number.isFinite(fields.order) ? fields.order : 0,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Rebuilds a task loaded from storage, keeping its id, order and timestamps. */
export function restoreTask(raw) {
  const fallback = new Date(0).toISOString();
  return {
    id: String(raw.id),
    ...normalizeFields(raw),
    order: Number.isFinite(raw.order) ? raw.order : 0,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : fallback,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : fallback,
  };
}

export function updateTask(task, changes) {
  const editable = Object.fromEntries(
    Object.entries(changes).filter(([key]) => EDITABLE_FIELDS.includes(key)),
  );
  return {
    ...task,
    ...normalizeFields({ ...task, ...editable }),
    updatedAt: new Date().toISOString(),
  };
}

/** Form values for a new task or for editing an existing one. */
export function toFormValues(task) {
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? DEFAULT_PRIORITY,
    dueDate: task?.dueDate ?? null,
    dueTime: task?.dueTime ?? null,
    reminders: [...(task?.reminders ?? [])],
    recurrence: task?.recurrence ? { ...task.recurrence } : null,
    estimateMinutes: task?.estimateMinutes ?? null,
    planned: task?.planned ? { ...task.planned } : null,
    labels: task?.labels ?? [],
    categoryId: task?.categoryId ?? null,
    subtasks: (task?.subtasks ?? []).map((subtask) => ({ ...subtask })),
  };
}
