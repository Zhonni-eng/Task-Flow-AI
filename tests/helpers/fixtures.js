// Deterministic test data builders. Every call returns fresh objects (no shared state).

export const FIXED_TODAY = new Date(2026, 9, 21, 12, 0, 0); // 21 Oct 2026, local time

let counter = 0;

export function makeTask(overrides = {}) {
  counter += 1;
  return {
    id: overrides.id ?? `task-${counter}`,
    title: `Task ${counter}`,
    description: '',
    priority: 'medium',
    dueDate: null,
    dueTime: null,
    reminders: [],
    recurrence: null,
    estimateMinutes: null,
    planned: null,
    labels: [],
    status: 'todo',
    order: 0,
    categoryId: null,
    subtasks: [],
    completedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeCategory(overrides = {}) {
  counter += 1;
  return {
    id: overrides.id ?? `cat-${counter}`,
    name: `Category ${counter}`,
    order: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Values the v3 -> v4 migration adds to a task (completedAt: see v4Fields). */
export const V4_TASK_DEFAULTS = Object.freeze({ dueTime: null, reminders: [], recurrence: null, estimateMinutes: null, planned: null });

/** A pre-v4 task as the v4 migration returns it: new fields empty, completedAt from updatedAt for done tasks. */
export const v4Fields = (task) => ({ ...V4_TASK_DEFAULTS, reminders: [], completedAt: task.status === 'done' ? task.updatedAt : null });

/** Settings a v4 document gains when they are missing. */
export const V4_SETTINGS_DEFAULTS = Object.freeze({ reminders: { enabled: true, allDayTime: '09:00' }, availability: null });

/** A current-version (v4) data document as written by electron/storage.cjs. */
export function makeDocument({ tasks = [], categories = [], settings = {} } = {}) {
  return {
    schemaVersion: 4,
    savedAt: '2026-10-20T00:00:00.000Z',
    settings: { language: 'ru', ...settings },
    categories,
    tasks,
  };
}
