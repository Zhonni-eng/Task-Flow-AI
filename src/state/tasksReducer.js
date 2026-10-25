// In-memory task state. Display order within a column is defined by each task's
// `order` field (kept as contiguous 0..n-1 per column), never by array position.
import { TASK_STATUSES, createTask, restoreTask, updateTask } from '../data/taskModel.js';
import { localDateKey, nextDueDateAfterCompletion } from '../../electron/shared/schedule.mjs';

export const taskActions = {
  create: (fields) => ({ type: 'task/created', task: createTask(fields) }),
  update: (id, changes) => ({ type: 'task/updated', id, changes }),
  remove: (id) => ({ type: 'task/deleted', id }),
  /** Moves a task to `status` at `index` within that column (also used for reordering). */
  move: (id, status, index) => ({ type: 'task/moved', id, status, index }),
  /** Moves every task of category `from` to category `to` (null = uncategorized). */
  reassignCategory: (from, to) => ({ type: 'task/categoryReassigned', from, to }),
  /** Bulk: moves the given tasks to `status` (appended to the end of that column). */
  bulkMove: (ids, status) => ({ type: 'tasks/bulkMoved', ids, status }),
  /** Bulk: applies the same field changes (priority, categoryId, dueDate) to the given tasks. */
  bulkUpdate: (ids, changes) => ({ type: 'tasks/bulkUpdated', ids, changes }),
  /** Bulk: deletes the given tasks and renumbers the affected columns. */
  bulkRemove: (ids) => ({ type: 'tasks/bulkDeleted', ids }),
  /**
   * Replaces whole tasks by id (inserting missing ones) and removes `removeIds`, then renumbers
   * every column. Used to apply a confirmed assistant plan and to undo one exactly.
   */
  replace: (tasks, removeIds = []) => ({ type: 'tasks/replaced', tasks, removeIds }),
};

/**
 * A task after a status change at `now`. Completing records completedAt; reopening clears it.
 * Completing a recurring task completes this occurrence: the task moves on to its next
 * occurrence (missed ones skipped), back to To Do with its checklist unticked.
 */
export function withStatus(task, status, now = new Date()) {
  if (task.status === status) return task;
  const stamp = now.toISOString();
  if (status === 'done' && task.recurrence && task.dueDate) {
    return {
      ...task,
      status: 'todo',
      dueDate: nextDueDateAfterCompletion(task.recurrence, task.dueDate, localDateKey(now)),
      subtasks: task.subtasks.map((subtask) => (subtask.done ? { ...subtask, done: false } : subtask)),
      planned: null,
      completedAt: stamp,
      updatedAt: stamp,
    };
  }
  return { ...task, status, completedAt: status === 'done' ? stamp : null, updatedAt: stamp };
}

/** Fields a bulk update may change; everything else on a task is left untouched. */
export const BULK_FIELDS = ['priority', 'categoryId', 'dueDate'];

/** Deterministic column order: `order`, then creation time, then id. */
export function compareTasks(a, b) {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function selectColumnTasks(tasks, status) {
  return tasks.filter((task) => task.status === status).sort(compareTasks);
}

function withOrder(task, order) {
  return task.order === order ? task : { ...task, order };
}

/** Applies replacement tasks by id; returns the original array if nothing changed. */
function applyUpdates(tasks, updates) {
  let changed = false;
  const next = tasks.map((task) => {
    const replacement = updates.get(task.id);
    if (replacement && replacement !== task) {
      changed = true;
      return replacement;
    }
    return task;
  });
  return changed ? next : tasks;
}

/** Renumbers a column so its orders are 0..n-1, preserving relative order. */
function renumberColumn(tasks, status) {
  const updates = new Map();
  selectColumnTasks(tasks, status).forEach((task, index) => updates.set(task.id, withOrder(task, index)));
  return applyUpdates(tasks, updates);
}

function placeTask(tasks, id, status, index) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return tasks;

  const sourceStatus = task.status;
  const moved = withStatus(task, status);
  // A completed recurring task has moved on to its next occurrence: top of To Do instead.
  const target = moved.status;
  const destination = selectColumnTasks(tasks, target).filter((item) => item.id !== id);
  const wanted = target === status ? index : 0;
  const position = Math.max(0, Math.min(Number.isInteger(wanted) ? wanted : destination.length, destination.length));
  destination.splice(position, 0, moved);

  const updates = new Map();
  destination.forEach((item, order) => updates.set(item.id, withOrder(item, order)));
  if (sourceStatus !== target) {
    selectColumnTasks(tasks, sourceStatus)
      .filter((item) => item.id !== id)
      .forEach((item, order) => updates.set(item.id, withOrder(item, order)));
  }
  return applyUpdates(tasks, updates);
}

/**
 * Moves several tasks to one status. Tasks are appended to the end of the target column
 * in their current display order (status, then position); tasks already in that status
 * keep their place. Source columns are renumbered by placeTask.
 */
function moveTasksToStatus(tasks, ids, status) {
  const selected = new Set(ids);
  const moving = TASK_STATUSES.flatMap((column) => selectColumnTasks(tasks, column)).filter(
    (task) => selected.has(task.id) && task.status !== status,
  );
  return moving.reduce((next, task) => placeTask(next, task.id, status, Number.MAX_SAFE_INTEGER), tasks);
}

/** Applies the same allowed field changes to several tasks; unchanged tasks keep their identity. */
function updateTasks(tasks, ids, changes) {
  const selected = new Set(ids);
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => BULK_FIELDS.includes(key)));
  let changed = false;
  const next = tasks.map((task) => {
    if (!selected.has(task.id)) return task;
    const updated = updateTask(task, allowed);
    const differs = Object.keys(allowed).some((key) => updated[key] !== task[key]);
    if (!differs) return task;
    changed = true;
    return updated;
  });
  return changed ? next : tasks;
}

function removeTasks(tasks, ids) {
  const selected = new Set(ids);
  const removed = tasks.filter((task) => selected.has(task.id));
  if (removed.length === 0) return tasks;
  const statuses = new Set(removed.map((task) => task.status));
  return [...statuses].reduce(
    (next, status) => renumberColumn(next, status),
    tasks.filter((task) => !selected.has(task.id)),
  );
}

/** Restores saved tasks and renumbers every column to contiguous 0..n-1 orders. */
export function restoreTasks(rawTasks) {
  return TASK_STATUSES.reduce(
    (tasks, status) => renumberColumn(tasks, status),
    rawTasks.map(restoreTask),
  );
}

export function tasksReducer(state, action) {
  switch (action.type) {
    case 'task/created':
      // Newest tasks appear at the top of their column.
      return placeTask([...state, action.task], action.task.id, action.task.status, 0);
    case 'task/updated':
      return state.map((task) => (task.id === action.id ? updateTask(task, action.changes) : task));
    case 'task/deleted': {
      const task = state.find((item) => item.id === action.id);
      if (!task) return state;
      return renumberColumn(
        state.filter((item) => item.id !== action.id),
        task.status,
      );
    }
    case 'task/moved':
      return placeTask(state, action.id, action.status, action.index);
    case 'tasks/bulkMoved':
      return moveTasksToStatus(state, action.ids, action.status);
    case 'tasks/bulkUpdated':
      return updateTasks(state, action.ids, action.changes);
    case 'tasks/bulkDeleted':
      return removeTasks(state, action.ids);
    case 'tasks/replaced': {
      const removing = new Set(action.removeIds);
      const replacements = new Map(action.tasks.map((task) => [task.id, restoreTask(task)]));
      const kept = state.filter((task) => !removing.has(task.id)).map((task) => replacements.get(task.id) ?? task);
      const added = [...replacements.values()].filter((task) => !state.some((item) => item.id === task.id));
      return TASK_STATUSES.reduce((next, status) => renumberColumn(next, status), [...kept, ...added]);
    }
    case 'task/categoryReassigned': {
      if (!state.some((task) => task.categoryId === action.from)) return state;
      const now = new Date().toISOString();
      return state.map((task) =>
        task.categoryId === action.from ? { ...task, categoryId: action.to ?? null, updatedAt: now } : task,
      );
    }
    default:
      return state;
  }
}

/** All distinct labels in use, for quick reuse in the task form. */
export function collectLabels(tasks) {
  const seen = new Map();
  for (const task of tasks) {
    for (const label of task.labels) {
      const key = label.toLocaleLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    }
  }
  return [...seen.values()];
}
