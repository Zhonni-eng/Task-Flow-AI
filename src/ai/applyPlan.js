// Applying a validated, confirmed assistant plan - a pure function, so the result can be checked
// before it is dispatched and undone exactly. Works on copies; never on the live state.
//
// applyPlan({ tasks, categories, entries, now }) -> {
//   tasks:      final versions of every created or changed task (whole objects),
//   removeIds:  ids of deleted tasks,
//   categories: categories created for this plan,
//   undo:       { before: { id: task | null }, after: { id: task | null }, categoryIds },
//   counts:     { created, updated, deleted },
// }
// `entries` are validation entries (actionPlan.js) the user selected. Status changes go through the
// same rule as the board (withStatus: completedAt, recurring tasks move to their next occurrence).
import { createCategory } from '../data/categoryModel.js';
import { findMatchingCategory } from '../data/categoryMatch.js';
import { createSubtask } from '../data/subtasks.js';
import { createTask, updateTask } from '../data/taskModel.js';
import { editLabels, renameLabelIn } from './actionPlan.js';
import { withStatus } from '../state/tasksReducer.js';

const clone = (task) => (task ? structuredClone(task) : null);

export function applyPlan({ tasks, categories, entries, now = new Date() }) {
  const working = new Map(tasks.map((task) => [task.id, task]));
  const before = new Map();
  const created = new Set();
  const deleted = new Set();
  const newCategories = [];
  let createdCount = 0;

  const remember = (id) => {
    if (!before.has(id)) before.set(id, clone(working.get(id) ?? null));
  };
  const categoryFor = (name) => {
    if (!name) return null;
    const existing = findMatchingCategory(name, [...categories, ...newCategories]);
    if (existing) return existing.id;
    const category = createCategory(name, categories.length + newCategories.length);
    newCategories.push(category);
    return category.id;
  };
  /** Field changes (and a status change) on one task. New/changed tasks go to the top of their column. */
  const change = (id, changes, newCategory) => {
    const current = working.get(id);
    if (!current) return;
    remember(id);
    const { status, addLabels, removeLabels, ...fields } = changes;
    if (newCategory) fields.categoryId = categoryFor(newCategory);
    // Tag edits apply to the task's current tags: added ones merged, removed ones taken off.
    if (addLabels || removeLabels) fields.labels = editLabels(current.labels, addLabels, removeLabels);
    let next = Object.keys(fields).length > 0 ? updateTask(current, fields) : current;
    if (status && status !== current.status) next = { ...withStatus(next, status, now), order: -1 };
    working.set(id, next);
  };
  const remove = (id) => {
    if (!working.has(id)) return;
    remember(id);
    working.delete(id);
    if (created.has(id)) created.delete(id);
    else deleted.add(id);
  };
  const relabel = (id, edit) => {
    const current = working.get(id);
    if (!current) return;
    remember(id);
    working.set(id, updateTask(current, { labels: edit(current.labels) }));
  };
  const editSubtasks = (id, edit) => {
    const current = working.get(id);
    if (!current) return;
    remember(id);
    working.set(id, { ...current, subtasks: edit(current.subtasks), updatedAt: now.toISOString() });
  };

  entries.forEach((entry, position) => {
    const n = entry.normalized;
    switch (entry.type) {
      case 'create': {
        const fields = { ...n.fields, subtasks: n.fields.subtasks.map((title) => createSubtask(title)) };
        if (n.newCategory) fields.categoryId = categoryFor(n.newCategory);
        let task = createTask({ ...fields, status: 'todo' });
        if (n.fields.status !== 'todo') task = withStatus(task, n.fields.status, now);
        // In the proposed order, above the existing tasks of its column.
        task = { ...task, order: -entries.length + position };
        before.set(task.id, null);
        created.add(task.id);
        working.set(task.id, task);
        createdCount += 1;
        break;
      }
      case 'update':
        change(n.taskId, n.changes, n.newCategory);
        break;
      case 'delete':
        remove(n.taskId);
        break;
      case 'addSubtask':
        editSubtasks(n.taskId, (list) => [...list, createSubtask(n.title)]);
        break;
      case 'updateSubtask':
        editSubtasks(n.taskId, (list) => list.map((subtask) => (subtask.id === n.subtaskId ? { ...subtask, ...n.changes } : subtask)));
        break;
      case 'deleteSubtask':
        editSubtasks(n.taskId, (list) => list.filter((subtask) => subtask.id !== n.subtaskId));
        break;
      case 'moveSubtask': {
        const moving = working.get(n.taskId)?.subtasks.find((subtask) => subtask.id === n.subtaskId);
        if (!moving || !working.has(n.toTaskId)) break;
        editSubtasks(n.taskId, (list) => list.filter((subtask) => subtask.id !== n.subtaskId));
        editSubtasks(n.toTaskId, (list) => [...list, { ...moving }]);
        break;
      }
      case 'bulk':
        for (const id of n.matches) {
          if (n.operation === 'delete') remove(id);
          else change(id, n.changes, n.newCategory);
        }
        break;
      case 'renameLabel':
        for (const id of n.matches) relabel(id, (labels) => renameLabelIn(labels, n.label, n.newLabel));
        break;
      case 'deleteLabel':
        for (const id of n.matches) relabel(id, (labels) => editLabels(labels, [], [n.label]));
        break;
      case 'schedule':
        for (const item of n.items) {
          const current = working.get(item.taskId);
          if (!current) continue;
          remember(item.taskId);
          working.set(item.taskId, updateTask(current, { planned: { date: n.date, time: item.start } }));
        }
        break;
      default:
        break;
    }
  });

  const changedTasks = [...before.keys()].filter((id) => working.has(id)).map((id) => working.get(id));
  const after = Object.fromEntries([...before.keys()].map((id) => [id, clone(working.get(id) ?? null)]));
  return {
    tasks: changedTasks,
    removeIds: [...deleted],
    categories: newCategories,
    undo: { before: Object.fromEntries(before), after, categoryIds: newCategories.map((category) => category.id) },
    counts: { created: createdCount, updated: changedTasks.length - createdCount, deleted: deleted.size },
  };
}

// Fields compared to tell whether the user edited a task after the assistant changed it.
const TRACKED = ['title', 'description', 'priority', 'dueDate', 'dueTime', 'reminders', 'recurrence', 'estimateMinutes', 'planned', 'labels', 'status', 'categoryId', 'subtasks'];
const sameTask = (a, b) => TRACKED.every((field) => JSON.stringify(a?.[field] ?? null) === JSON.stringify(b?.[field] ?? null));

/**
 * Undo of an applied plan - only what is still exactly as the assistant left it.
 * Returns { tasks (to put back), removeIds (created tasks to remove), restored, removed, kept }.
 */
export function planUndo(undo, currentTasks) {
  const current = new Map(currentTasks.map((task) => [task.id, task]));
  const putBack = [];
  const removeIds = [];
  let kept = 0;
  let restored = 0;
  for (const [id, beforeTask] of Object.entries(undo.before)) {
    const afterTask = undo.after[id];
    const now = current.get(id) ?? null;
    if (afterTask === null) {
      // Deleted by the plan: restore it unless something with that id exists again.
      if (now) kept += 1;
      else if (beforeTask) {
        putBack.push(beforeTask);
        restored += 1;
      }
      continue;
    }
    if (!now || !sameTask(now, afterTask)) {
      kept += 1;
      continue;
    }
    if (beforeTask === null) removeIds.push(id);
    else {
      putBack.push(beforeTask);
      restored += 1;
    }
  }
  return { tasks: putBack, removeIds, restored, removed: removeIds.length, kept };
}
